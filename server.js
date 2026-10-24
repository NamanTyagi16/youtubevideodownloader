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

// Clean YouTube URLs: convert shorts/youtu.be to standard watch URLs and remove tracking params
function normalizeYouTubeUrl(rawUrl) {
    try {
        let u = rawUrl.trim();
        // Extract video ID from shorts or youtu.be
        const shortsMatch = u.match(/(?:shorts\/|youtu\.be\/|v\/|watch\?v=)([\w-]{11})/);
        if (shortsMatch && shortsMatch[1]) {
            return `https://www.youtube.com/watch?v=${shortsMatch[1]}`;
        }
        return u;
    } catch {
        return rawUrl;
    }
}

// Base options: Uses iOS/Android client extraction which completely bypasses YouTube's bot sign-in prompt
function getBaseOptions() {
    return {
        ffmpegLocation: ffmpegPath,
        noWarnings: true,
        extractorArgs: 'youtube:player_client=ios,android'
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

        const targetUrl = normalizeYouTubeUrl(url);
        console.log(`[Single Download] Processing: ${targetUrl} (Format: ${format}, Quality: ${quality})`);

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

        res.download(outputPath, `video-${Date.now()}.${fileExt}`, (err) => {
            if (err) console.error('Error sending file:', err);
            cleanupFile(outputPath);
        });

    } catch (error) {
        console.error('Download error details:', error.stderr || error.message || error);
        cleanupFile(outputPath);
        
        const rawErr = String(error.stderr || error.message || '');
        let userMessage = 'Error downloading video.';
        if (rawErr.includes('This video is unavailable')) {
            userMessage = 'This video is unavailable or restricted by YouTube.';
        } else if (rawErr.includes('Private video')) {
            userMessage = 'This video is private.';
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

        const targetUrl = normalizeYouTubeUrl(url);
        console.log(`[Clip Extractor] Processing: ${targetUrl} (${start} to ${end})`);

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

        res.download(outputPath, `clip-${Date.now()}.mp4`, (err) => {
            if (err) console.error('Error sending clip:', err);
            cleanupFile(outputPath);
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
                const targetUrl = normalizeYouTubeUrl(u);
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
