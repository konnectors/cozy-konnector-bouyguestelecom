const fs = require('fs')
const path = require('path')
module.exports = {
  COZY_CREDENTIALS: fs.readFileSync(path.join(__dirname, 'token.json')),
  COZY_URL: 'http://cozy.local:8080',
  COZY_FIELDS: '{"phoneNumber": "0000000000", "password": "password", "folderPath": "Bouygues"}'
}
