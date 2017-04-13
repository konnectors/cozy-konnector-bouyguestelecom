const fs = require('fs')
const path = require('path')
const tokenPath = path.join(__dirname, 'token.json')
module.exports = {
  COZY_CREDENTIALS: fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath) : 'NO TOKEN',
  COZY_URL: 'https://christophe.cozy.rocks',
  COZY_FIELDS: '{"phoneNumber": "0616312701", "password": "5q=cI1^^SN{#`@zJ", "folderPath": "Bouygues/telecom"}'
}
