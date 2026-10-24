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

// Helper to get yt-dlp base options including cookies
function getBaseOptions() {
    const opts = {
        ffmpegLocation: ffmpegPath,
        noWarnings: true
    };
    const cookiesPath = path.resolve(__dirname, 'cookies.txt');
    if (fs.existsSync(cookiesPath)) {
        opts.cookies = cookiesPath;
    } else if (process.platform === 'win32') {
        opts.cookiesFromBrowser = 'chrome';
    }
    return opts;
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'CreatorScope Engine is running!' });
});

// Video info preview endpoint (Fast metadata lookup)
app.get('/api/info', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) return res.status(400).json({ error: 'URL parameter is required' });

        const info = await youtubedl(url, {
            ...getBaseOptions(),
            dumpSingleJson: true,
            skipDownload: true
        });

        res.json({
            title: info.title || 'YouTube Video',
            duration: info.duration || 0,
            duration_string: info.duration_string || '',
            thumbnail: info.thumbnail || '',
            channel: info.uploader || info.channel || ''
        });
    } catch (err) {
        console.error('Info lookup error:', err.message || err);
        res.status(500).json({ error: 'Could not fetch video metadata. Verify link or access.' });
    }
});

// Single Video Download endpoint
app.get('/download', async (req, res) => {
    let outputPath = null;
    try {
        const { url, quality = 'best', format = 'mp4' } = req.query;
        if (!url) return res.status(400).json({ error: 'Missing video URL' });

        console.log(`[Single Download] Starting for: ${url} (Format: ${format}, Quality: ${quality})`);

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
            dlOptions.audioQuality = 0; // Best quality MP3
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

        await youtubedl(url, dlOptions);

        res.download(outputPath, `download-${Date.now()}.${fileExt}`, (err) => {
            if (err) console.error('Error sending file:', err);
            cleanupFile(outputPath);
        });

    } catch (error) {
        console.error('Download error:', error);
        cleanupFile(outputPath);
        res.status(500).json({ error: 'Error downloading video. Please check URL or restrictions.' });
    }
});

// Timestamp Clip Extractor endpoint
app.get('/clip', async (req, res) => {
    let outputPath = null;
    try {
        const { url, start, end } = req.query;
        if (!url || !start || !end) {
            return res.status(400).json({ error: 'Missing required parameters: url, start, end' });
        }

        console.log(`[Clip Extractor] Starting: ${url} (${start} to ${end})`);

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

        await youtubedl(url, dlOptions);

        res.download(outputPath, `clip-${Date.now()}.mp4`, (err) => {
            if (err) console.error('Error sending clip:', err);
            cleanupFile(outputPath);
        });

    } catch (error) {
        console.error('Clip generation error:', error);
        cleanupFile(outputPath);
        res.status(500).json({ error: 'Error generating clip. Please ensure timestamps exist inside video duration.' });
    }
});

// Batch Queue Process endpoint (Processes multiple links fast)
app.post('/api/batch', async (req, res) => {
    try {
        const { urls, format = 'mp4', quality = 'best' } = req.body;
        if (!Array.isArray(urls) || urls.length === 0) {
            return res.status(400).json({ error: 'Please provide an array of URLs' });
        }

        // Limit batch to max 20 per request to protect server resources
        const validUrls = urls.map(u => u.trim()).filter(Boolean).slice(0, 20);
        console.log(`[Batch Processing] Received ${validUrls.length} URLs`);

        // Fast metadata inspection for each
        const results = await Promise.all(validUrls.map(async (u, idx) => {
            try {
                const info = await youtubedl(u, {
                    ...getBaseOptions(),
                    dumpSingleJson: true,
                    skipDownload: true
                });
                return {
                    id: `job-${Date.now()}-${idx}`,
                    url: u,
                    title: info.title || `Video ${idx + 1}`,
                    duration: info.duration_string || `${info.duration || 0}s`,
                    thumbnail: info.thumbnail || '',
                    status: 'ready',
                    downloadUrl: `/download?url=${encodeURIComponent(u)}&format=${format}&quality=${quality}`
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
