const pino = require('pino');
const readline = require('readline');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore
} = require('sanka-baileyss');
const fs = require('fs');
const path = require('path');
const yts = require('yt-search');
const { exec } = require('child_process');
const https = require('https');

const usePairingCode = true;
const question = (text) => new Promise((res) =>
  readline.createInterface({ input: process.stdin, output: process.stdout }).question(text, res)
);

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./session');
  const sock = makeWASocket({
    printQRInTerminal: !usePairingCode,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys) },
    logger: pino({ level: 'warn' })
  });

  sock.ev.on('creds.update', saveCreds);

  if (usePairingCode && !sock.authState.creds.registered) {
    const phone = await question('📱 Enter your WhatsApp number (e.g. 23480xxxx): ');
    const code = await sock.requestPairingCode(phone.trim());
    console.log('\n🔗 Pairing code:', code);
    console.log('👉 Open WhatsApp > Linked Devices to enter it\n');
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (
      connection === 'close' &&
      lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
    ) {
      console.log('🔌 Reconnecting...');
      connectToWhatsApp();
    } else if (connection === 'open') {
      console.log('✅ Connected');
    }
  });

  // === MESSAGE HANDLER WITH MUSIC COMMAND ===
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;

    const from = msg.key.remoteJid;
    const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const prefix = '!'; // command prefix
    if (!body.startsWith(prefix)) return;

    const args = body.slice(prefix.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();

    if (command === 'music' || command === 'play') {
      const query = args.join(' ');
      if (!query) {
        await sock.sendMessage(from, { text: '❌ Provide a song name\nExample: !music Shape of You' }, { quoted: msg });
        return;
      }

      await sock.sendMessage(from, { text: `🔍 Searching YouTube for: *${query}*` }, { quoted: msg });

      try {
        const res = await yts(query);
        const video = res.videos[0];
        if (!video) {
          await sock.sendMessage(from, { text: '❌ No results found.' }, { quoted: msg });
          return;
        }

        const fileNameSafe = video.title.replace(/[\\/:*?"<>|]/g, '');
        const outputPath = path.resolve(__dirname, `temp_${Date.now()}.mp3`);
        const thumbnailPath = path.resolve(__dirname, `thumb_${Date.now()}.jpg`);

        // Download thumbnail
        const file = fs.createWriteStream(thumbnailPath);
        https.get(video.thumbnail, (response) => {
          response.pipe(file);
          file.on('finish', async () => {
            file.close();

            const caption = `🎵 *${video.title}*\n👤 *Uploader:* ${video.author.name}\n⏱️ *Duration:* ${video.timestamp}\n📺 *Link:* ${video.url}`;
            const thumbBuffer = fs.readFileSync(thumbnailPath);

            await sock.sendMessage(from, { image: thumbBuffer, caption }, { quoted: msg });

            // Download audio with yt-dlp
            const command = `yt-dlp -x --audio-format mp3 -o "${outputPath}" "${video.url}"`;
            exec(command, async (error) => {
              if (error) {
                console.error('❌ Download error:', error.message);
                await sock.sendMessage(from, { text: '❌ Failed to download audio.' }, { quoted: msg });
                return;
              }

              const audioBuffer = fs.readFileSync(outputPath);
              await sock.sendMessage(from, {
                audio: audioBuffer,
                mimetype: 'audio/mp4',
                fileName: `${fileNameSafe}.mp3`
              }, { quoted: msg });

              fs.unlinkSync(outputPath);
              fs.unlinkSync(thumbnailPath);
            });
          });
        });
      } catch (err) {
        console.error('❌ Music plugin error:', err);
        await sock.sendMessage(from, { text: '❌ An error occurred. Try again later.' }, { quoted: msg });
      }
    }
  });
}

connectToWhatsApp().catch(console.error);
