// Builds a standalone HTML transcript of a channel.

function esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Very small markdown renderer (after escaping)
function md(text = '') {
  let t = esc(text);
  t = t.replace(/```(?:\w+\n)?([\s\S]*?)```/g, '<pre>$1</pre>');
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/__([^_]+)__/g, '<u>$1</u>');
  t = t.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<i>$1</i>');
  t = t.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  t = t.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  return t.replace(/\n/g, '<br>');
}

async function fetchAllMessages(channel) {
  const all = [];
  let before;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

function renderEmbed(e) {
  const color = e.color != null ? '#' + e.color.toString(16).padStart(6, '0') : '#4f545c';
  let html = `<div class="embed" style="border-left-color:${color}">`;
  if (e.author?.name) html += `<div class="embed-author">${esc(e.author.name)}</div>`;
  if (e.title) html += `<div class="embed-title">${esc(e.title)}</div>`;
  if (e.description) html += `<div class="embed-desc">${md(e.description)}</div>`;
  for (const f of e.fields || []) {
    html += `<div class="embed-field"><div class="embed-field-name">${esc(f.name)}</div><div>${md(f.value)}</div></div>`;
  }
  if (e.image?.url) html += `<img class="attach" src="${esc(e.image.url)}">`;
  if (e.footer?.text) html += `<div class="embed-footer">${esc(e.footer.text)}</div>`;
  return html + '</div>';
}

async function generateTranscript(channel, meta = {}) {
  const messages = await fetchAllMessages(channel);

  const rows = messages
    .map((m) => {
      const avatar = m.author.displayAvatarURL({ extension: 'png', size: 64 });
      const time = m.createdAt.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
      const name = m.member?.displayName || m.author.globalName || m.author.username;

      const content = m.content ? `<div class="content">${md(m.cleanContent)}</div>` : '';
      const embeds = m.embeds.map(renderEmbed).join('');
      const attachments = [...m.attachments.values()]
        .map((a) =>
          a.contentType?.startsWith('image/')
            ? `<div><img class="attach" src="${esc(a.url)}" alt="${esc(a.name)}"></div>`
            : `<div class="file">📎 <a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.name)}</a></div>`
        )
        .join('');

      return `
      <div class="msg">
        <img class="avatar" src="${esc(avatar)}" alt="">
        <div class="body">
          <div class="head">
            <span class="name">${esc(name)}</span>
            ${m.author.bot ? '<span class="tag">BOT</span>' : ''}
            <span class="time">${time}</span>
          </div>
          ${content}${embeds}${attachments}
        </div>
      </div>`;
    })
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Transcript - ${esc(channel.name)}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#313338;color:#dbdee1;font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px}
  .top{background:#2b2d31;padding:20px 28px;border-bottom:1px solid #1e1f22}
  .top h1{margin:0 0 6px;font-size:20px;color:#fff}
  .top div{color:#949ba4;font-size:13px;margin-top:2px}
  .wrap{padding:16px 28px 40px;max-width:1000px;margin:0 auto}
  .msg{display:flex;gap:14px;padding:8px 0}
  .avatar{width:40px;height:40px;border-radius:50%;flex-shrink:0}
  .body{min-width:0;flex:1}
  .name{font-weight:600;color:#fff}
  .tag{background:#5865f2;color:#fff;font-size:10px;padding:1px 5px;border-radius:4px;margin-left:6px;vertical-align:middle}
  .time{color:#949ba4;font-size:12px;margin-left:8px}
  .content{margin-top:2px;word-wrap:break-word;overflow-wrap:anywhere;line-height:1.4}
  a{color:#00a8fc}
  code{background:#1e1f22;padding:1px 5px;border-radius:4px;font-size:13px}
  pre{background:#1e1f22;padding:10px;border-radius:6px;overflow-x:auto;margin:4px 0}
  .embed{background:#2b2d31;border-left:4px solid #4f545c;border-radius:4px;padding:10px 14px;margin-top:6px;max-width:520px}
  .embed-title{font-weight:700;color:#fff;margin-bottom:4px}
  .embed-author{font-size:13px;font-weight:600;margin-bottom:4px}
  .embed-field{margin-top:8px}
  .embed-field-name{font-weight:700;font-size:13px;color:#fff}
  .embed-footer{font-size:12px;color:#949ba4;margin-top:8px}
  .attach{max-width:400px;max-height:300px;border-radius:6px;margin-top:6px}
  .file{margin-top:6px}
</style>
</head>
<body>
  <div class="top">
    <h1>#${esc(channel.name)}</h1>
    <div>Server: ${esc(channel.guild.name)}</div>
    ${meta.type ? `<div>Type: ${esc(meta.type)}</div>` : ''}
    ${meta.owner ? `<div>Opened by: ${esc(meta.owner)}</div>` : ''}
    ${meta.claimedBy ? `<div>Claimed by: ${esc(meta.claimedBy)}</div>` : ''}
    ${meta.closedBy ? `<div>Deleted by: ${esc(meta.closedBy)}</div>` : ''}
    <div>Messages: ${messages.length} &bull; Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC</div>
  </div>
  <div class="wrap">
${rows}
  </div>
</body>
</html>`;

  return { html, count: messages.length };
}

module.exports = { generateTranscript };
