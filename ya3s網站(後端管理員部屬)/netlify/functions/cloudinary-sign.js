// netlify/functions/cloudinary-sign.js
// 用途：在伺服器端產生 Cloudinary 上傳簽章，讓前端可以做「Signed Upload」
// 重點：CLOUDINARY_API_SECRET 只存在於 Netlify 環境變數，絕對不會出現在前端程式碼裡

const crypto = require('crypto');

exports.handler = async function (event) {
  // 只允許 POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!apiKey || !apiSecret) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: '伺服器尚未設定 CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET 環境變數'
      })
    };
  }

  try {
    const timestamp = Math.round(Date.now() / 1000);

    // 要被簽章的參數：跟前端 formData 裡（除了 file / api_key / signature 之外）的參數要完全一致
    const paramsToSign = {
      timestamp: timestamp,
      upload_preset: 'ya3s_upload'
    };

    // Cloudinary 規則：依參數名稱字母順序排列，組成 key=value&key=value 字串，最後接上 api_secret 做 SHA-1
    const sortedKeys = Object.keys(paramsToSign).sort();
    const stringToSign = sortedKeys
      .map(function (key) { return key + '=' + paramsToSign[key]; })
      .join('&');

    const signature = crypto
      .createHash('sha1')
      .update(stringToSign + apiSecret)
      .digest('hex');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        signature: signature,
        timestamp: timestamp,
        apiKey: apiKey
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
