#!/bin/bash
# Zoom OAuth helper. Starts a local server to capture the OAuth callback,
# opens the browser for Zoom login, and saves the token.
#
# Usage: zoom-auth.sh

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

CONFIG="$HOME/.claude/channels/zoom/config.json"
TOKEN_FILE="$HOME/.claude/channels/zoom/token.json"

CLIENT_ID=$(jq -r '.client_id' "$CONFIG")
CLIENT_SECRET=$(jq -r '.client_secret' "$CONFIG")
REDIRECT_URI=$(jq -r '.redirect_uri' "$CONFIG")

# Start a temporary HTTP server to capture the callback
node -e "
const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname === '/auth/callback' && parsed.query.code) {
    const code = parsed.query.code;
    console.log('Got auth code:', code);

    // Exchange code for token
    const auth = Buffer.from('${CLIENT_ID}:${CLIENT_SECRET}').toString('base64');
    const postData = 'grant_type=authorization_code&code=' + code + '&redirect_uri=${REDIRECT_URI}';

    const tokenReq = https.request({
      hostname: 'zoom.us',
      path: '/oauth/token',
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }, (tokenRes) => {
      let data = '';
      tokenRes.on('data', (chunk) => data += chunk);
      tokenRes.on('end', () => {
        fs.writeFileSync('${TOKEN_FILE}', data);
        console.log('Token saved to ${TOKEN_FILE}');
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end('<html><body><h1>Zoom authenticated!</h1><p>You can close this window.</p></body></html>');
        setTimeout(() => { server.close(); process.exit(0); }, 1000);
      });
    });
    tokenReq.write(postData);
    tokenReq.end();
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(4000, () => {
  console.log('Listening on port 4000 for OAuth callback...');
});

setTimeout(() => { console.log('Timeout - no callback received'); server.close(); process.exit(1); }, 120000);
" &

NODE_PID=$!
sleep 1

# Open browser for Zoom login
open "https://zoom.us/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}"

echo "Browser opened for Zoom login. Waiting for callback..."
wait $NODE_PID
echo "Done."
