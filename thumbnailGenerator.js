const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');

function createThumbnail(videoPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .screenshots({
                count: 1,
                folder: path.dirname(outputPath),
                filename: path.basename(outputPath),
                size: '320x240'
            })
            .on('end', resolve)
            .on('error', reject);
    });
}

module.exports = { createThumbnail };
