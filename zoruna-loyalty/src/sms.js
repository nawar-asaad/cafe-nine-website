// إرسال الرسائل النصية: console للتجربة، twilio، أو أي بوابة SMS محلية عبر رابط HTTP.
const config = require('./config');

const { sms } = config;

async function send(to, text) {
  switch (sms.provider) {
    case 'twilio': {
      const { sid, token, from } = sms.twilio;
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: from || sms.sender, Body: text }),
      });
      return res.ok;
    }
    case 'http': {
      const url = sms.httpUrl
        .replace('{to}', encodeURIComponent(to))
        .replace('{text}', encodeURIComponent(text))
        .replace('{sender}', encodeURIComponent(sms.sender));
      const res = await fetch(url);
      return res.ok;
    }
    default:
      console.log(`[sms → ${to}] ${text}`);
      return true;
  }
}

// نضيف دائماً طريقة إيقاف الرسائل احتراماً للزبون (ومطلوبة قانونياً في أغلب الدول)
const withOptOut = (text, serial) => `${text}\nلإيقاف الرسائل: ${config.publicUrl}/stop/${serial}`;

module.exports = { send, withOptOut };
