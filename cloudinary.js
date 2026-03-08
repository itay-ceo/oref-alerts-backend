const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload a file buffer to Cloudinary.
 * @param {Buffer} buffer
 * @param {string} folder - e.g. "oref-sounds"
 * @param {'image'|'video'|'raw'|'auto'} resourceType - use 'video' for audio files
 * @returns {Promise<string>} secure URL
 */
async function uploadBuffer(buffer, folder, resourceType = 'auto', timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Cloudinary upload timed out after ${timeoutMs}ms`)), timeoutMs);
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: resourceType },
      (err, result) => {
        clearTimeout(timer);
        if (err) return reject(err);
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

/**
 * Upload a local file path to Cloudinary.
 * @param {string} filePath
 * @param {string} folder
 * @param {'image'|'video'|'raw'|'auto'} resourceType
 * @returns {Promise<string>} secure URL
 */
async function uploadFile(filePath, folder, resourceType = 'auto') {
  const result = await cloudinary.uploader.upload(filePath, {
    folder,
    resource_type: resourceType,
  });
  return result.secure_url;
}

module.exports = { uploadBuffer, uploadFile };
