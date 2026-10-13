const express = require('express');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.static('public')); // Serve the frontend UI

// Health check endpoint
app.get('/', (req, res) => {
    res.send('CreatorScope Backend is running!');
});

// Clip endpoint
// Example: http://localhost:3000/clip?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&start=00:00:10&end=00:00:20
app.get('/clip', async (req, res) => {
    try {
        const { url, start, end } = req.query;

        if (!url || !start || !end) {
            return res.status(400).json({ error: "Missing required parameters: url, start, end" });
        }

        console.log(`Starting download for ${url} from ${start} to ${end}...`);

        // Generate a unique filename using timestamp to avoid conflicts
        const filename = `clip-${Date.now()}.mp4`;
        const outputPath = path.resolve(__dirname, filename);

        // Prepare yt-dlp options
        const dlOptions = {
            downloadSections: `*${start}-${end}`,
            format: 'bestvideo+bestaudio/best',
            mergeOutputFormat: 'mp4',
            forceKeyframesAtCuts: true,
            ffmpegLocation: ffmpegPath, // Use the bundled ffmpeg
            output: outputPath,
            forceOverwrites: true,
            noWarnings: true
        };

        // Check for cookies file on cloud/local
        const cookiesPath = path.resolve(__dirname, 'cookies.txt');
        if (fs.existsSync(cookiesPath)) {
            dlOptions.cookies = cookiesPath;
        } else if (process.platform === 'win32') {
            dlOptions.cookiesFromBrowser = 'chrome';
        }

        // Execute yt-dlp to download the specific section
        await youtubedl(url, dlOptions);

        console.log(`Clip successfully generated: ${outputPath}`);

        // Send the file to the user
        res.download(outputPath, 'clip.mp4', (err) => {
            if (err) {
                console.error("Error sending file:", err);
            }
            // Delete the file after it's sent to save disk space
            fs.unlink(outputPath, (unlinkErr) => {
                if (unlinkErr) console.error("Error deleting file:", unlinkErr);
                else console.log(`Deleted temp file: ${outputPath}`);
            });
        });

    } catch (error) {
        console.error("Error generating clip:", error);
        res.status(500).json({ error: "Error generating clip. Please check the URL and timestamps." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
