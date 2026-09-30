require('dotenv').config();

const {
  Client,
  Events,
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

// ───────────── CONFIG (IDs default to yours; only the token is required) ─────────────
const TOKEN = process.env.DISCORD_TOKEN;
const TICKET_CHANNEL_ID = process.env.TICKET_CHANNEL_ID || '1513904277515534506';
const CATEGORY_ID = process.env.TICKET_CATEGORY_ID || '1539749321048596610';
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || '1539787269769269258';
const STAFF_ROLE_IDS = (process.env.STAFF_ROLE_IDS || '1513904136783925380')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Embed color (purple). Change to 0x8a2be2 for a more vivid purple.
const COLOR = 0x9b59b6;

// Animated emoji used on the Claim button
const CLAIM_EMOJI = { id: '1552077450442186862', name: 'emoji_14', animated: true };

const TYPES = {
  support: { label: 'Support Ticket', emoji: '🛠️', prefix: 'support' },
  report: { label: 'Report Ticket', emoji: '🚨', prefix: 'report' },
};

if (!TOKEN) {
  console.error('❌ DISCORD_TOKEN is missing. Add it in Railway → your service → Variables.');
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
      .setEmoji(CLAIM_EMOJI)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(claimed),
    closed
      ? new ButtonBuilder().setCustomId('ticket_reopen').setLabel('Reopen').setEmoji('🔓').setStyle(ButtonStyle.Secondary)
      : new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket_delete').setLabel('Delete Ticket').setEmoji('🗑️').setStyle(ButtonStyle.Secondary)
  );
}

function ticketTypeMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('ticket_type')
      .setPlaceholder('Select a ticket type')
      .addOptions(
        { label: 'Support Ticket', value: 'support', emoji: '🛠️', description: 'Get help from the staff team' },
        { label: 'Report Ticket', value: 'report', emoji: '🚨', description: 'Report a user or an issue' }
      )
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
  return field?.value.match(/<@!?(\d+)>/)?.[1] || null;
};

const reply = (i, content) => i.reply({ content, flags: MessageFlags.Ephemeral });

// ───────────── STARTUP CHECKS (prints clear reasons in Railway logs) ─────────────
async function startupChecks() {
  const need = (ch, perms, label) => {
    const me = ch.guild.members.me;
    const p = ch.permissionsFor(me);
    const missing = perms.filter(([, flag]) => !p?.has(flag)).map(([n]) => n);
    if (missing.length) console.error(`❌ ${label}: bot is missing permissions → ${missing.join(', ')}`);
    else console.log(`✅ ${label}: permissions OK`);
  };

  const ticketCh = await client.channels.fetch(TICKET_CHANNEL_ID).catch((e) => {
    console.error(`❌ Ticket channel ${TICKET_CHANNEL_ID} not accessible: ${e.message}. Is the bot in that server and able to view the channel?`);
    return null;
  });
  if (ticketCh) {
    need(ticketCh, [['View Channel', PermissionFlagsBits.ViewChannel], ['Send Messages', PermissionFlagsBits.SendMessages], ['Embed Links', PermissionFlagsBits.EmbedLinks]], 'Ticket channel');
  }

  const cat = await client.channels.fetch(CATEGORY_ID).catch((e) => {
    console.error(`❌ Category ${CATEGORY_ID} not accessible: ${e.message}`);
    return null;
  });
  if (cat) {
    if (cat.type !== ChannelType.GuildCategory) console.error(`❌ TICKET_CATEGORY_ID ${CATEGORY_ID} is NOT a category (it is a normal channel). Copy the ID of the category itself.`);
    else need(cat, [['View Channel', PermissionFlagsBits.ViewChannel], ['Manage Channels', PermissionFlagsBits.ManageChannels]], 'Category');
  }

  const log = await client.channels.fetch(LOG_CHANNEL_ID).catch((e) => {
    console.error(`❌ Log channel ${LOG_CHANNEL_ID} not accessible: ${e.message}`);
    return null;
  });
  if (log) {
    need(log, [['View Channel', PermissionFlagsBits.ViewChannel], ['Send Messages', PermissionFlagsBits.SendMessages], ['Attach Files', PermissionFlagsBits.AttachFiles]], 'Log channel');
  }

  return ticketCh;
}

// ───────────── PANEL ─────────────
async function ensurePanel(channel) {
  if (!channel) return;
  try {
    const recent = await channel.messages.fetch({ limit: 30 }).catch(() => null);
    const exists = recent?.some(
      (m) => m.author.id === client.user.id && m.components?.[0]?.components?.[0]?.customId === 'ticket_type'
    );
    if (exists) return console.log('ℹ️ Panel already exists, not sending a new one.');

    const embed = new EmbedBuilder()
      .setColor(COLOR)
      .setTitle('🎫 Ticket')
      .setDescription('Choose your ticket.\n\nSelect the type of ticket you want to open from the dropdown below.')
      .setFooter({ text: channel.guild.name });

    await channel.send({ embeds: [embed], components: [ticketTypeMenu()] });
    console.log('✅ Panel sent.');
  } catch (err) {
    console.error(`❌ Could not send the panel: ${err.message} (code ${err.code}). Give the bot View Channel + Send Messages + Embed Links in the ticket channel.`);
  }
}

// ───────────── HANDLERS ─────────────
async function handleCreate(i) {
  const type = i.values[0];
  const info = TYPES[type];
  if (!info) return;

  // The select menu now lives on the shared, persistent panel message (not a
  // one-off ephemeral message like before), so this must NOT update i.message —
  // that would edit the panel itself for everyone. deferReply()/editReply()
  // instead opens a private reply of its own, same as a fresh i.reply() would.
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = i.guild;
  const user = i.user;

  // One open ticket per user
  const existing = guild.channels.cache.find(
    (c) => c.parentId === CATEGORY_ID && parseTopic(c)?.owner === user.id
  );
  if (existing) {
    return i.editReply({ content: `❌ You already have an open ticket: ${existing}` });
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

  await i.editReply({ content: `✅ Your ticket has been created: ${channel}` });
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
    const { html, text, count } = await generateTranscript(channel, {
      type: TYPES[data.type]?.label || data.type,
      owner: ownerUser?.tag || data.owner,
      claimedBy: claimedUser?.tag,
      closedBy: i.user.tag,
      names: {
        [data.owner]: ownerUser?.username,
        ...(claimedId ? { [claimedId]: claimedUser?.username } : {}),
        [i.user.id]: i.user.username,
        ...Object.fromEntries(STAFF_ROLE_IDS.map((id) => ['r' + id, 'staff'])),
      },
    });

    const files = () => [
      new AttachmentBuilder(Buffer.from(html, 'utf-8'), { name: `transcript-${channel.name}.html` }),
      new AttachmentBuilder(Buffer.from(text, 'utf-8'), { name: `transcript-${channel.name}.txt` }),
    ];

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
    await logChannel.send({ embeds: [logEmbed], files: files() });

    // Also DM a copy to the ticket owner (silently ignored if DMs are closed)
    if (ownerUser) {
      await ownerUser
        .send({ content: `Your ticket **#${channel.name}** was closed. Here is your transcript:`, files: files() })
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
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const ticketCh = await startupChecks();
  await ensurePanel(ticketCh);
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isButton()) {
      switch (i.customId) {
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
    const msg = { content: '❌ Something went wrong. Check the bot permissions and category ID.', flags: MessageFlags.Ephemeral };
    if (i.deferred || i.replied) i.followUp(msg).catch(() => {});
    else i.reply(msg).catch(() => {});
  }
});

client.on('error', (e) => console.error('Client error:', e));
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

client.login(TOKEN).catch((e) => {
  console.error(`❌ Login failed: ${e.message}. The token is wrong or was reset — paste the NEW token in Railway Variables.`);
  process.exit(1);
});
