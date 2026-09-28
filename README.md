# Discord Ticket Bot

Panel with one button → choose **Support** or **Report** → private ticket channel is created in your ticket category.
Inside the ticket: **Claim / Close Ticket / Delete Ticket** buttons. On delete, an **HTML transcript** is sent to your log channel (and DM'd to the ticket owner).

## 1. Create the bot
1. https://discord.com/developers/applications → **New Application** → **Bot** tab.
2. Copy the **token** (Reset Token). Keep it secret.
3. Under **Privileged Gateway Intents** enable **Message Content Intent** (needed for transcripts).
4. **OAuth2 → URL Generator**: scope `bot`; permissions: Manage Channels, View Channels, Send Messages, Manage Messages, Embed Links, Attach Files, Read Message History, Mention Everyone/Roles. (Or just give **Administrator**.)
5. Invite the bot to your server.

## 2. Get the IDs
Enable Developer Mode (Settings → Advanced), then right-click → **Copy ID**:
- `TICKET_CATEGORY_ID` – the **category** where tickets get created
- `LOG_CHANNEL_ID` – channel where transcripts go
- `STAFF_ROLE_IDS` – staff role + any higher roles, comma separated (`123,456`)
- `TICKET_CHANNEL_ID` – already set to `1513904277515534506`

The bot's role must be **above** nothing special, but it must be able to see the ticket channel, the category and the log channel.

## 3. Put it on GitHub
```bash
git init
git add .
git commit -m "ticket bot"
git branch -M main
git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
git push -u origin main
```
`.env` is git-ignored – never push your token.

## 4. Deploy on Railway
1. https://railway.app → **New Project → Deploy from GitHub repo** → pick the repo.
2. Open the service → **Variables** and add:
   - `DISCORD_TOKEN`
   - `TICKET_CHANNEL_ID`
   - `TICKET_CATEGORY_ID`
   - `LOG_CHANNEL_ID`
   - `STAFF_ROLE_IDS`
3. Railway auto-detects Node and runs `npm start`. Check **Deployments → Logs** for `✅ Logged in`.

## Notes
- The panel is posted automatically on startup. If the panel message already exists it won't be duplicated. To re-send it, delete the old one and restart.
- Ticket owner/type are stored in the channel topic, so nothing is lost when Railway restarts (no database needed).
- Each user can have 1 open ticket at a time.
- Closing removes the user's ability to type; staff can Reopen or Delete.

## Local testing
```bash
cp .env.example .env   # fill it in
npm install
npm start
```
