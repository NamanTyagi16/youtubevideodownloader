const express = require('express');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Create downloads directory for temporary files
const downloadsDir = path.resolve(__dirname, 'temp_downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}

// Clean and extract standard YouTube URL
function cleanYouTubeUrl(rawUrl) {
    if (!rawUrl) return '';
    let u = rawUrl.trim();
    const match = u.match(/(?:shorts\/|youtu\.be\/|embed\/|v\/|watch\?v=)([\w-]{11})/i);
    if (match && match[1]) {
        return `https://www.youtube.com/watch?v=${match[1]}`;
    }
    return u;
}

// The mediaconnect client does not trigger YouTube's datacenter bot challenge or require cookies
function getBaseOptions() {
    return {
        ffmpegLocation: ffmpegPath,
        noWarnings: true,
        extractorArgs: 'youtube:player_client=mediaconnect'
    };
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'CreatorScope Engine is running!' });
});

// Single Video Download endpoint
app.get('/download', async (req, res) => {
    let outputPath = null;
    try {
        let { url, quality = 'best', format = 'mp4' } = req.query;
        if (!url) return res.status(400).json({ error: 'Missing video URL' });

        const targetUrl = cleanYouTubeUrl(url);
        console.log(`[Single Download] Starting: ${targetUrl} (Format: ${format}, Quality: ${quality})`);

        const isAudio = format === 'mp3';
        const fileExt = isAudio ? 'mp3' : 'mp4';
        const filename = `video-${Date.now()}.${fileExt}`;
        outputPath = path.resolve(downloadsDir, filename);

        const dlOptions = {
            ...getBaseOptions(),
            output: outputPath,
            forceOverwrites: true
        };

        if (isAudio) {
            dlOptions.extractAudio = true;
            dlOptions.audioFormat = 'mp3';
            dlOptions.audioQuality = 0;
        } else {
            if (quality === '1080') {
                dlOptions.format = 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best';
            } else if (quality === '720') {
                dlOptions.format = 'bestvideo[height<=720]+bestaudio/best[height<=720]/best';
            } else {
                dlOptions.format = 'bestvideo+bestaudio/best';
            }
            dlOptions.mergeOutputFormat = 'mp4';
        }

        await youtubedl(targetUrl, dlOptions);

        const finalFile = resolveActualFile(outputPath);
        if (!finalFile) {
            throw new Error('Downloaded file could not be located.');
        }

        res.download(finalFile, `video-${Date.now()}.${fileExt}`, (err) => {
            if (err) console.error('Error sending file:', err);
            cleanupFile(finalFile);
        });

    } catch (error) {
        console.error('Download error details:', error.stderr || error.message || error);
        cleanupFile(outputPath);
        
        const rawErr = String(error.stderr || error.message || '');
        let userMessage = 'Error downloading video.';
        if (rawErr.includes('This video is unavailable')) {
            userMessage = 'This video is unavailable, deleted, or restricted.';
        }
        res.status(500).json({ error: userMessage, details: rawErr.slice(0, 300) });
    }
});

// Timestamp Clip Extractor endpoint
app.get('/clip', async (req, res) => {
    let outputPath = null;
    try {
        let { url, start, end } = req.query;
        if (!url || !start || !end) {
            return res.status(400).json({ error: 'Missing required parameters: url, start, end' });
        }

        const targetUrl = cleanYouTubeUrl(url);
        console.log(`[Clip Extractor] Starting: ${targetUrl} (${start} to ${end})`);

        const filename = `clip-${Date.now()}.mp4`;
        outputPath = path.resolve(downloadsDir, filename);

        const dlOptions = {
            ...getBaseOptions(),
            downloadSections: `*${start}-${end}`,
            format: 'bestvideo+bestaudio/best',
            mergeOutputFormat: 'mp4',
            forceKeyframesAtCuts: true,
            output: outputPath,
            forceOverwrites: true
        };

        await youtubedl(targetUrl, dlOptions);

        const finalFile = resolveActualFile(outputPath);
        if (!finalFile) {
            throw new Error('Generated clip could not be located.');
        }

        res.download(finalFile, `clip-${Date.now()}.mp4`, (err) => {
            if (err) console.error('Error sending clip:', err);
            cleanupFile(finalFile);
        });

    } catch (error) {
        console.error('Clip generation error details:', error.stderr || error.message || error);
        cleanupFile(outputPath);
        res.status(500).json({ error: 'Error generating clip. Please ensure timestamps exist inside video duration.', details: String(error.stderr || error.message || '').slice(0, 300) });
    }
});

// Batch Queue Process endpoint
app.post('/api/batch', async (req, res) => {
    try {
        const { urls, format = 'mp4', quality = 'best' } = req.body;
        if (!Array.isArray(urls) || urls.length === 0) {
            return res.status(400).json({ error: 'Please provide an array of URLs' });
        }

        const validUrls = urls.map(u => u.trim()).filter(Boolean).slice(0, 20);
        console.log(`[Batch Processing] Received ${validUrls.length} URLs`);

        const results = await Promise.all(validUrls.map(async (u, idx) => {
            try {
                const targetUrl = cleanYouTubeUrl(u);
                const info = await youtubedl(targetUrl, {
                    ...getBaseOptions(),
                    dumpSingleJson: true,
                    skipDownload: true
                });
                return {
                    id: `job-${Date.now()}-${idx}`,
                    url: targetUrl,
                    title: info.title || `Video ${idx + 1}`,
                    duration: info.duration_string || `${info.duration || 0}s`,
                    thumbnail: info.thumbnail || '',
                    status: 'ready',
                    downloadUrl: `/download?url=${encodeURIComponent(targetUrl)}&format=${format}&quality=${quality}`
                };
            } catch (err) {
                return {
                    id: `job-${Date.now()}-${idx}`,
                    url: u,
                    title: 'Failed to inspect link',
                    duration: '--',
                    thumbnail: '',
                    status: 'error',
                    error: err.message ? err.message.slice(0, 100) : 'Invalid or restricted link'
                };
            }
        }));

        res.json({ success: true, count: results.length, items: results });
    } catch (err) {
        console.error('Batch error:', err);
        res.status(500).json({ error: 'Batch processing failed' });
    }
});

// Helper to resolve exact file path when yt-dlp appends or modifies extensions
function resolveActualFile(basePath) {
    if (fs.existsSync(basePath)) return basePath;
    const dir = path.dirname(basePath);
    const baseName = path.basename(basePath);
    const files = fs.readdirSync(dir);
    for (const file of files) {
        if (file.startsWith(baseName.replace(/\.[^/.]+$/, ''))) {
            return path.join(dir, file);
        }
    }
    return null;
}

// Safe cleanup utility
function cleanupFile(filePath) {
    if (filePath && fs.existsSync(filePath)) {
        fs.unlink(filePath, (err) => {
            if (err) console.error('Cleanup error:', err);
            else console.log(`[Cleanup] Removed: ${path.basename(filePath)}`);
        });
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`CreatorScope Engine live on http://localhost:${PORT}`);
});
