require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits,
  AttachmentBuilder,
  MessageFlags,
} = require('discord.js');
const { generateTranscript } = require('./transcript');

// ───────────── CONFIG ─────────────
const TOKEN = process.env.DISCORD_TOKEN;
const TICKET_CHANNEL_ID = process.env.TICKET_CHANNEL_ID || '1513904277515534506';
const CATEGORY_ID = process.env.TICKET_CATEGORY_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const STAFF_ROLE_IDS = (process.env.STAFF_ROLE_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const COLOR = 0x5865f2;
const TYPES = {
  support: { label: 'Support Ticket', emoji: '🛠️', prefix: 'support' },
  report: { label: 'Report Ticket', emoji: '🚨', prefix: 'report' },
};

if (!TOKEN || !CATEGORY_ID || !LOG_CHANNEL_ID || STAFF_ROLE_IDS.length === 0) {
  console.error('Missing env vars. Need DISCORD_TOKEN, TICKET_CATEGORY_ID, LOG_CHANNEL_ID, STAFF_ROLE_IDS');
  process.exit(1);
}

const client = new Client({
  // MessageContent is needed so transcripts can read message text
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

// ───────────── HELPERS ─────────────
const isStaff = (member) =>
  member.permissions.has(PermissionFlagsBits.Administrator) ||
  member.roles.cache.some((r) => STAFF_ROLE_IDS.includes(r.id));

// Ticket info is stored in the channel topic:  ticket|owner=ID|type=support
function parseTopic(channel) {
  if (!channel?.topic || !channel.topic.startsWith('ticket|')) return null;
  const data = {};
  for (const part of channel.topic.split('|').slice(1)) {
    const [k, v] = part.split('=');
    data[k] = v;
  }
  return data;
}

function ticketButtons({ claimed = false, closed = false } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_claim')
      .setLabel(claimed ? 'Claimed' : 'Claim')
      .setEmoji('🙋')
      .setStyle(ButtonStyle.Success)
      .setDisabled(claimed),
    closed
      ? new ButtonBuilder().setCustomId('ticket_reopen').setLabel('Reopen').setEmoji('🔓').setStyle(ButtonStyle.Primary)
      : new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket_delete').setLabel('Delete Ticket').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
  );
}

const panelState = (msg) => {
  const row = msg.components?.[0]?.components || [];
  return {
    claimed: row[0]?.disabled === true,
    closed: row[1]?.customId === 'ticket_reopen',
  };
};

const getClaimedBy = (msg) => {
  const field = msg.embeds?.[0]?.fields?.find((f) => f.name === 'Claimed by');
  return field?.value.match(/\d+/)?.[0] || null;
};

const reply = (i, content) => i.reply({ content, flags: MessageFlags.Ephemeral });

// ───────────── PANEL ─────────────
async function ensurePanel() {
  const channel = await client.channels.fetch(TICKET_CHANNEL_ID).catch(() => null);
  if (!channel) return console.error('❌ Ticket channel not found. Check TICKET_CHANNEL_ID and bot access.');

  const recent = await channel.messages.fetch({ limit: 30 }).catch(() => null);
  const exists = recent?.some(
    (m) => m.author.id === client.user.id && m.components?.[0]?.components?.[0]?.customId === 'ticket_open'
  );
  if (exists) return console.log('ℹ️ Panel already exists.');

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('🎫 Ticket')
    .setDescription('Choose your ticket.\n\nPress the button below and select the type of ticket you want to open.')
    .setFooter({ text: channel.guild.name });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_open').setLabel('Open a Ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary)
  );

  await channel.send({ embeds: [embed], components: [row] });
  console.log('✅ Panel sent.');
}

// ───────────── HANDLERS ─────────────
async function handleOpenButton(i) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('ticket_type')
    .setPlaceholder('Select a ticket type')
    .addOptions(
      { label: 'Support Ticket', value: 'support', emoji: '🛠️', description: 'Get help from the staff team' },
      { label: 'Report Ticket', value: 'report', emoji: '🚨', description: 'Report a user or an issue' }
    );
  await i.reply({
    content: 'What kind of ticket do you want to open?',
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleCreate(i) {
  const type = i.values[0];
  const info = TYPES[type];
  if (!info) return;

  await i.deferUpdate();

  const guild = i.guild;
  const user = i.user;

  // One open ticket per user
  const existing = guild.channels.cache.find(
    (c) => c.parentId === CATEGORY_ID && parseTopic(c)?.owner === user.id
  );
  if (existing) {
    return i.editReply({ content: `❌ You already have an open ticket: ${existing}`, components: [] });
  }

  const safeName = user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || user.id;

  const channel = await guild.channels.create({
    name: `${info.prefix}-${safeName}`,
    type: ChannelType.GuildText,
    parent: CATEGORY_ID,
    topic: `ticket|owner=${user.id}|type=${type}`,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      },
      ...STAFF_ROLE_IDS.map((id) => ({
        id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageMessages,
        ],
      })),
      {
        id: client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AttachFiles,
        ],
      },
    ],
  });

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`${info.emoji} ${info.label}`)
    .setDescription(
      `Welcome ${user}!\nPlease describe your ${type === 'report' ? 'report' : 'issue'} in detail and a staff member will be with you shortly.`
    )
    .addFields(
      { name: 'Opened by', value: `${user}`, inline: true },
      { name: 'Type', value: info.label, inline: true }
    )
    .setTimestamp();

  await channel.send({
    content: `${user} ${STAFF_ROLE_IDS.map((id) => `<@&${id}>`).join(' ')}`,
    embeds: [embed],
    components: [ticketButtons()],
    allowedMentions: { users: [user.id], roles: STAFF_ROLE_IDS },
  });

  await i.editReply({ content: `✅ Your ticket has been created: ${channel}`, components: [] });
}

async function handleClaim(i) {
  if (!isStaff(i.member)) return reply(i, '❌ Only staff can claim tickets.');

  const state = panelState(i.message);
  if (state.claimed) return reply(i, '❌ This ticket is already claimed.');

  const embed = EmbedBuilder.from(i.message.embeds[0]);
  const fields = (embed.data.fields || []).filter((f) => f.name !== 'Claimed by');
  embed.setFields([...fields, { name: 'Claimed by', value: `${i.user}`, inline: true }]);

  await i.update({ embeds: [embed], components: [ticketButtons({ claimed: true, closed: state.closed })] });
  await i.channel.send({
    embeds: [new EmbedBuilder().setColor(0x57f287).setDescription(`🙋 Ticket claimed by ${i.user}`)],
  });
}

async function handleClose(i) {
  const data = parseTopic(i.channel);
  if (!data) return reply(i, '❌ This is not a ticket channel.');
  if (!isStaff(i.member) && i.user.id !== data.owner) return reply(i, '❌ You cannot close this ticket.');

  const state = panelState(i.message);
  await i.channel.permissionOverwrites.edit(data.owner, { SendMessages: false }).catch(() => {});

  await i.update({ components: [ticketButtons({ claimed: state.claimed, closed: true })] });
  await i.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0xfee75c)
        .setDescription(`🔒 Ticket closed by ${i.user}. Staff can **Reopen** or **Delete** it.`),
    ],
  });
}

async function handleReopen(i) {
  const data = parseTopic(i.channel);
  if (!data) return reply(i, '❌ This is not a ticket channel.');
  if (!isStaff(i.member)) return reply(i, '❌ Only staff can reopen tickets.');

  const state = panelState(i.message);
  await i.channel.permissionOverwrites.edit(data.owner, { SendMessages: true }).catch(() => {});

  await i.update({ components: [ticketButtons({ claimed: state.claimed, closed: false })] });
  await i.channel.send({
    embeds: [new EmbedBuilder().setColor(0x57f287).setDescription(`🔓 Ticket reopened by ${i.user}.`)],
  });
}

async function handleDelete(i) {
  const data = parseTopic(i.channel);
  if (!data) return reply(i, '❌ This is not a ticket channel.');
  if (!isStaff(i.member)) return reply(i, '❌ Only staff can delete tickets.');

  await i.reply({
    embeds: [new EmbedBuilder().setColor(0xed4245).setDescription('🗑️ Generating transcript… this channel will be deleted in 5 seconds.')],
  });

  const channel = i.channel;
  const claimedId = getClaimedBy(i.message);
  const ownerUser = await client.users.fetch(data.owner).catch(() => null);
  const claimedUser = claimedId ? await client.users.fetch(claimedId).catch(() => null) : null;

  try {
    const { html, count } = await generateTranscript(channel, {
      type: TYPES[data.type]?.label || data.type,
      owner: ownerUser?.tag || data.owner,
      claimedBy: claimedUser?.tag,
      closedBy: i.user.tag,
    });

    const file = () => new AttachmentBuilder(Buffer.from(html, 'utf-8'), { name: `transcript-${channel.name}.html` });

    const logEmbed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('📄 Ticket Deleted')
      .addFields(
        { name: 'Ticket', value: `#${channel.name}`, inline: true },
        { name: 'Type', value: TYPES[data.type]?.label || 'Unknown', inline: true },
        { name: 'Messages', value: `${count}`, inline: true },
        { name: 'Opened by', value: `<@${data.owner}>`, inline: true },
        { name: 'Claimed by', value: claimedId ? `<@${claimedId}>` : 'Nobody', inline: true },
        { name: 'Deleted by', value: `${i.user}`, inline: true }
      )
      .setTimestamp();

    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
    await logChannel.send({ embeds: [logEmbed], files: [file()] });

    // Also DM a copy to the ticket owner (silently ignored if DMs are closed)
    if (ownerUser) {
      await ownerUser
        .send({ content: `Your ticket **#${channel.name}** was closed. Here is your transcript:`, files: [file()] })
        .catch(() => {});
    }
  } catch (err) {
    console.error('Transcript error:', err);
    await channel.send('⚠️ Failed to generate/send the transcript. Deletion cancelled.').catch(() => {});
    return;
  }

  setTimeout(() => channel.delete('Ticket deleted').catch(console.error), 5000);
}

// ───────────── EVENTS ─────────────
client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await ensurePanel();
});

client.on('interactionCreate', async (i) => {
  try {
    if (i.isButton()) {
      switch (i.customId) {
        case 'ticket_open': return await handleOpenButton(i);
        case 'ticket_claim': return await handleClaim(i);
        case 'ticket_close': return await handleClose(i);
        case 'ticket_reopen': return await handleReopen(i);
        case 'ticket_delete': return await handleDelete(i);
      }
    } else if (i.isStringSelectMenu() && i.customId === 'ticket_type') {
      return await handleCreate(i);
    }
  } catch (err) {
    console.error('Interaction error:', err);
    const msg = { content: '❌ Something went wrong.', flags: MessageFlags.Ephemeral };
    if (i.deferred || i.replied) i.followUp(msg).catch(() => {});
    else i.reply(msg).catch(() => {});
  }
});

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
client.login(TOKEN);
