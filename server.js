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

// Write cookies from environment variable if provided (for Render / cloud)
const envCookies = process.env.YOUTUBE_COOKIES_TEXT;
const cookiesPath = path.resolve(__dirname, 'cookies.txt');
if (envCookies && !fs.existsSync(cookiesPath)) {
    try {
        fs.writeFileSync(cookiesPath, envCookies, 'utf8');
        console.log('[Cookies] cookies.txt generated from YOUTUBE_COOKIES_TEXT environment variable.');
    } catch (e) {
        console.error('[Cookies] Error writing cookies.txt from env:', e);
    }
}

// Helper to get yt-dlp base options
function getBaseOptions() {
    const opts = {
        ffmpegLocation: ffmpegPath,
        noWarnings: true,
        // Mimic modern real browser client to avoid "bot" restriction
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        referer: 'https://www.youtube.com/',
        extractorArgs: 'youtube:player_client=android,web'
    };

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

        await youtubedl(url, dlOptions);

        res.download(outputPath, `video-${Date.now()}.${fileExt}`, (err) => {
            if (err) console.error('Error sending file:', err);
            cleanupFile(outputPath);
        });

    } catch (error) {
        console.error('Download error details:', error.stderr || error.message || error);
        cleanupFile(outputPath);
        
        const rawErr = String(error.stderr || error.message || '');
        let userMessage = 'Error downloading video.';
        if (rawErr.includes('Sign in to confirm you’re not a bot')) {
            userMessage = 'YouTube Bot Protection: Add YOUTUBE_COOKIES_TEXT on Render or cookies.txt to authenticate.';
        } else if (rawErr.includes('Video unavailable')) {
            userMessage = 'This video is private, removed, or region-restricted.';
        }
        res.status(500).json({ error: userMessage, details: rawErr.slice(0, 300) });
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
        console.error('Clip generation error details:', error.stderr || error.message || error);
        cleanupFile(outputPath);
        
        const rawErr = String(error.stderr || error.message || '');
        let userMessage = 'Error generating clip.';
        if (rawErr.includes('Sign in to confirm you’re not a bot')) {
            userMessage = 'YouTube Bot Protection: Add YOUTUBE_COOKIES_TEXT on Render or cookies.txt to authenticate.';
        }
        res.status(500).json({ error: userMessage, details: rawErr.slice(0, 300) });
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
