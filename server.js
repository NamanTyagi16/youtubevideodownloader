const express = require('express');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');
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

const cookiesPath = path.resolve(__dirname, 'cookies.txt');

// Build Netscape cookies file using all available environment variables
function initCookies() {
    const rawCookies = process.env.YOUTUBE_COOKIES_TEXT;
    const sid = process.env.YT_SID;
    const hsid = process.env.YT_HSID;
    const ssid = process.env.YT_SSID;
    const secure1psid = process.env.YT_SECURE_1PSID;
    const secure3psid = process.env.YT_SECURE_3PSID;
    const loginInfo = process.env.YT_LOGIN_INFO;

    if (rawCookies) {
        fs.writeFileSync(cookiesPath, rawCookies, 'utf8');
        return true;
    } 
    
    let lines = ['# Netscape HTTP Cookie File'];
    const addCookie = (name, val) => {
        if (!val) return;
        const clean = String(val).trim().replace(/^"(.*)"$/, '$1');
        lines.push(`.youtube.com\tTRUE\t/\tTRUE\t2147483647\t${name}\t${clean}`);
        lines.push(`.google.com\tTRUE\t/\tTRUE\t2147483647\t${name}\t${clean}`);
    };

    addCookie('__Secure-1PSID', secure1psid);
    addCookie('__Secure-3PSID', secure3psid);
    addCookie('LOGIN_INFO', loginInfo);
    addCookie('SID', sid);
    addCookie('HSID', hsid);
    addCookie('SSID', ssid);

    if (lines.length > 1) {
        fs.writeFileSync(cookiesPath, lines.join('\n') + '\n', 'utf8');
        return true;
    }
    return fs.existsSync(cookiesPath);
}

initCookies();

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

function getBaseOptions() {
    const opts = {
        ffmpegLocation: ffmpegPath,
        noWarnings: true
    };

    if (fs.existsSync(cookiesPath)) {
        opts.cookies = cookiesPath;
    } else if (process.platform === 'win32') {
        opts.cookiesFromBrowser = 'chrome';
    }

    return opts;
}

// Universal Stream Downloader / Slicer via FFmpeg
// This extracts stream URLs directly and streams via FFmpeg, completely bypassing yt-dlp download blocks
async function streamProcessVideo(targetUrl, outputPath, options = {}) {
    const { start, end, isAudio = false, quality = 'best' } = options;

    console.log(`[StreamEngine] Extracting direct video/audio stream URLs for ${targetUrl}...`);
    const info = await youtubedl(targetUrl, {
        ...getBaseOptions(),
        dumpSingleJson: true,
        skipDownload: true
    });

    const formats = (info.formats || []).filter(f => f.url && f.url.startsWith('https://') && !f.url.includes('manifest'));
    if (!formats.length) {
        throw new Error('No direct stream streams found.');
    }

    // Audio stream
    const audioFormat = formats.find(f => f.acodec !== 'none' && f.vcodec === 'none' && (f.ext === 'm4a' || f.ext === 'mp4')) ||
                        formats.find(f => f.acodec !== 'none' && f.vcodec === 'none') || formats[0];

    // Video stream
    let videoFormat;
    if (!isAudio) {
        const vids = formats.filter(f => f.vcodec !== 'none' && f.ext === 'mp4');
        if (quality === '720') {
            videoFormat = vids.find(f => f.height <= 720) || vids[0];
        } else if (quality === '1080') {
            videoFormat = vids.find(f => f.height <= 1080) || vids[0];
        } else {
            videoFormat = vids[0] || formats.find(f => f.vcodec !== 'none');
        }
    }

    return new Promise((resolve, reject) => {
        let args = ['-y'];

        if (start) args.push('-ss', start);
        if (end) args.push('-to', end);

        if (isAudio) {
            args.push('-i', audioFormat.url, '-vn', '-c:a', 'libmp3lame', '-q:a', '0', outputPath);
        } else {
            args.push('-i', videoFormat.url);
            if (start) args.push('-ss', start);
            if (end) args.push('-to', end);
            args.push('-i', audioFormat.url);
            args.push('-c:v', 'copy', '-c:a', 'aac', outputPath);
        }

        console.log(`[FFmpeg] Executing stream processing -> ${path.basename(outputPath)}`);
        const proc = spawn(ffmpegPath, args);

        let errLog = '';
        proc.stderr.on('data', data => { errLog += data.toString(); });

        proc.on('close', code => {
            if (code === 0 && fs.existsSync(outputPath)) {
                console.log(`[FFmpeg] Stream completed successfully -> ${path.basename(outputPath)}`);
                resolve(outputPath);
            } else {
                console.error(`[FFmpeg] Failed (code ${code}):`, errLog.slice(-400));
                reject(new Error(`FFmpeg stream process failed: ${errLog.slice(-200)}`));
            }
        });

        proc.on('error', reject);
    });
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        authenticated: fs.existsSync(cookiesPath),
        message: 'CreatorScope Engine is running!'
    });
});

// Single Video Download endpoint
app.get('/download', async (req, res) => {
    let outputPath = null;
    try {
        let { url, quality = 'best', format = 'mp4' } = req.query;
        if (!url) return res.status(400).json({ error: 'Missing video URL' });

        const targetUrl = cleanYouTubeUrl(url);
        console.log(`[Single Download] Processing: ${targetUrl} (Format: ${format}, Quality: ${quality})`);

        const isAudio = format === 'mp3';
        const fileExt = isAudio ? 'mp3' : 'mp4';
        const filename = `video-${Date.now()}.${fileExt}`;
        outputPath = path.resolve(downloadsDir, filename);

        // Process directly via FFmpeg stream pipeline
        await streamProcessVideo(targetUrl, outputPath, { isAudio, quality });

        res.download(outputPath, `video-${Date.now()}.${fileExt}`, (err) => {
            if (err) console.error('Error sending file:', err);
            cleanupFile(outputPath);
        });

    } catch (error) {
        console.error('Download error details:', error.message || error);
        cleanupFile(outputPath);
        res.status(500).json({ error: 'Error downloading video.', details: String(error.message || '').slice(0, 300) });
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
        console.log(`[Clip Extractor] Processing: ${targetUrl} (${start} to ${end})`);

        const filename = `clip-${Date.now()}.mp4`;
        outputPath = path.resolve(downloadsDir, filename);

        // Slices stream directly at the network level in seconds
        await streamProcessVideo(targetUrl, outputPath, { start, end, isAudio: false });

        res.download(outputPath, `clip-${Date.now()}.mp4`, (err) => {
            if (err) console.error('Error sending clip:', err);
            cleanupFile(outputPath);
        });

    } catch (error) {
        console.error('Clip generation error details:', error.message || error);
        cleanupFile(outputPath);
        res.status(500).json({ error: 'Error generating clip. Please ensure timestamps exist inside video duration.', details: String(error.message || '').slice(0, 300) });
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
