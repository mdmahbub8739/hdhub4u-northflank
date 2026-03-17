const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const CryptoJS = require('crypto-js');

const app = express();
const PORT = process.env.PORT || 8080;

const DOMAIN = "https://hdhub4u.rehab";
const TMDB_API = "https://wild-surf-4a0d.phisher1.workers.dev";
const TMDB_KEY = "1865f43a0549ca50d341dd9ab8b29f49";
const HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Cookie": "xla=s4t" };

// ==========================================
// 1. CORE UTILS (Bypass, ROT13, Decryption)
// ==========================================
function pen(value) {
    return value.replace(/[a-zA-Z]/g, c => {
        const base = c <= 'Z' ? 65 : 97;
        return String.fromCharCode((c.charCodeAt(0) - base + 13) % 26 + base);
    });
}
function base64Decode(str) { return Buffer.from(str, 'base64').toString('utf-8'); }

async function getRedirectLinks(url) {
    try {
        const { data: html } = await axios.get(url, { headers: HEADERS });
        const regex = /s\('o','([A-Za-z0-9+/=]+)'|ck\('_wp_http_\d+','([^']+)'/g;
        let combinedString = ""; let match;
        while ((match = regex.exec(html)) !== null) combinedString += match[1] || match[2];
        if (!combinedString) return url;
        
        const decodedString = base64Decode(pen(base64Decode(base64Decode(combinedString))));
        const jsonObj = JSON.parse(decodedString);
        const encodedUrl = base64Decode(jsonObj.o || "").trim();
        if (encodedUrl) return encodedUrl;
        
        const reData = Buffer.from(jsonObj.data || "", 'base64').toString('utf-8').trim();
        const wphttp1 = (jsonObj.blog_url || "").trim();
        const redirectRes = await axios.get(`${wphttp1}?re=${reData}`);
        const $ = cheerio.load(redirectRes.data);
        return $('body').text().trim();
    } catch (e) { return url; }
}

function decryptVidstackAES(inputHex) {
    const key = CryptoJS.enc.Utf8.parse("kiemtienmua911ca");
    const ivList =["1234567890oiuytr", "0123456789abcdef"];
    const encryptedBase64 = CryptoJS.enc.Base64.stringify(CryptoJS.enc.Hex.parse(inputHex));
    for (let ivStr of ivList) {
        try {
            const decrypted = CryptoJS.AES.decrypt(encryptedBase64, key, { iv: CryptoJS.enc.Utf8.parse(ivStr), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 });
            const result = decrypted.toString(CryptoJS.enc.Utf8);
            if (result) return result;
        } catch (e) { continue; }
    }
    return null;
}

// ==========================================
// 2. CLOUDSTREAM REPLICA ROUTES
// ==========================================

// HOMEPAGE EXTRACTOR (Cloudstream getMainPage)
app.get('/home', async (req, res) => {
    const page = req.query.page || 1;
    const category = req.query.category || ""; // Example: "category/web-series/"
    const url = `${DOMAIN}/${category}page/${page}/`;
    
    try {
        const { data } = await axios.get(url, { headers: HEADERS });
        const $ = cheerio.load(data);
        const homeList =[];
        
        $('.recent-movies > li.thumb').each((i, el) => {
            const title = $(el).find('figcaption:nth-child(2) > a:nth-child(1) > p:nth-child(1)').text().trim();
            const link = $(el).find('figure:nth-child(1) > a:nth-child(2)').attr('href');
            const poster = $(el).find('figure:nth-child(1) > img:nth-child(1)').attr('src');
            homeList.push({ title, url: link, posterUrl: poster });
        });
        res.json({ success: true, page, results: homeList });
    } catch (err) { res.json({ success: false, error: err.message }); }
});

// PINGORA SEARCH (Cloudstream search)
app.get('/search', async (req, res) => {
    const query = req.query.q;
    const page = req.query.page || 1;
    const url = `https://search.pingora.fyi/collections/post/documents/search?q=${query}&query_by=post_title,category&query_by_weights=4,2&sort_by=sort_by_date:desc&limit=15&use_cache=true&page=${page}`;
    try {
        const { data } = await axios.get(url, { headers: { ...HEADERS, "Referer": DOMAIN } });
        const hits = data.hits.map(h => ({
            title: h.document.post_title,
            url: h.document.permalink,
            posterUrl: h.document.post_thumbnail,
            type: h.document.post_type
        }));
        res.json({ success: true, results: hits });
    } catch (err) { res.json({ success: false, error: err.message }); }
});

// LOAD DETAILS & TMDB & EPISODES (Cloudstream load)
app.get('/load', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.send({ error: "URL required" });

    try {
        const { data } = await axios.get(url, { headers: HEADERS });
        const $ = cheerio.load(data);
        
        const title = $('.page-body h2[data-ved], h1.page-title span').first().text().trim();
        const poster = $('main.page-body img.aligncenter').attr('src');
        const plot = $('.kno-rdesc .kno-rdesc').first().text().trim();
        const isTV = $('h1.page-title span').text().toLowerCase().includes('movie') ? false : true;
        
        let tmdbId = "";
        const tmdbHref = $("div span a[href*='themoviedb.org']").attr('href');
        if (tmdbHref) tmdbId = tmdbHref.split('/').pop().split('-')[0].split('?')[0];

        // Scrape streaming links
        let links =[];
        if (!isTV) {
            // Movies: match 480|720|1080|2160|4K
            $('h3 a, h4 a, .page-body > div a').each((i, el) => {
                const text = $(el).text();
                const href = $(el).attr('href');
                if (href && /480|720|1080|2160|4K|hdstream4u|hubstream/i.test(text + href)) links.push(href);
            });
        } else {
            // TV Series: Group by Episode
            $('h5 a').each((i, el) => {
                const href = $(el).attr('href');
                if (href && href.includes('?id=')) links.push(href);
            });
        }
        
        // Fetch TMDB Metadata (Like your worker API)
        let tmdbData = null;
        if (tmdbId) {
            const type = isTV ? "tv" : "movie";
            try {
                const tmdbRes = await axios.get(`${TMDB_API}/${type}/${tmdbId}?api_key=${TMDB_KEY}&append_to_response=credits,external_ids`);
                tmdbData = tmdbRes.data;
            } catch (e) {}
        }

        res.json({
            success: true,
            title: tmdbData?.name || tmdbData?.title || title,
            isTvSeries: isTV,
            posterUrl: tmdbData?.poster_path ? `https://image.tmdb.org/t/p/original${tmdbData.poster_path}` : poster,
            plot: tmdbData?.overview || plot,
            rating: tmdbData?.vote_average,
            raw_links:[...new Set(links)]
        });
    } catch (err) { res.json({ success: false, error: err.message }); }
});

// THE ULTIMATE EXTRACTOR (Cloudstream loadLinks / HubCloud / VidStack)
app.get('/extract', async (req, res) => {
    let url = req.query.url;
    if (!url) return res.send({ error: "URL required" });

    try {
        // 1. Resolve redirect if ?id= exists
        if (url.includes('?id=')) {
            url = await getRedirectLinks(url);
        }

        // 2. HubCloud Logic
        if (url.toLowerCase().includes('hubcloud')) {
            const { data } = await axios.get(url, { headers: HEADERS });
            const $ = cheerio.load(data);
            const raw = $('#download').attr('href');
            let href = raw?.startsWith('http') ? raw : new URL(url).origin + "/" + raw?.replace(/^\//, '');
            
            if (href) {
                const hubDoc = await axios.get(href, { headers: HEADERS });
                const $$ = cheerio.load(hubDoc.data);
                let extractedLinks =[];
                
                $$('a.btn').each((i, el) => {
                    const link = $$(el).attr('href');
                    const label = $$(el).text().toLowerCase();
                    if (label.includes('pixeldrain') || label.includes('pixelserver')) {
                        let finalUrl = link.includes('download') ? link : `https://pixeldrain.com/api/file/${link.split('/').pop()}?download`;
                        extractedLinks.push({ server: "Pixeldrain", url: finalUrl });
                    } else if (label.includes('buzzserver') || label.includes('fsl') || label.includes('s3')) {
                        extractedLinks.push({ server: label.trim(), url: link });
                    }
                });
                return res.json({ success: true, source: "HubCloud", links: extractedLinks });
            }
        }

        // 3. VidStack Logic (AES Decryption)
        if (url.toLowerCase().includes('vidstack.io') || url.toLowerCase().includes('hubstream')) {
            const hash = url.split('#').pop().split('/').pop();
            const baseUrl = new URL(url).origin;
            const apiCall = await axios.get(`${baseUrl}/api/v1/video?id=${hash}`, { headers: HEADERS });
            
            const decryptedText = decryptVidstackAES(apiCall.data.trim());
            if (decryptedText) {
                const m3u8Match = decryptedText.match(/"source":"(.*?)"/);
                const m3u8 = m3u8Match ? m3u8Match[1].replace(/\\\//g, "/") : "";
                return res.json({ success: true, source: "VidStack", isM3U8: true, url: m3u8 });
            }
        }

        // 4. Hubcdn Logic
        if (url.toLowerCase().includes('hubcdn')) {
            const { data } = await axios.get(url, { headers: HEADERS });
            const encodedMatch = data.match(/r=([A-Za-z0-9+/=]+)/);
            if (encodedMatch) {
                const m3u8 = base64Decode(encodedMatch[1]).split('link=').pop();
                return res.json({ success: true, source: "HubCDN", isM3U8: true, url: m3u8 });
            }
        }

        res.json({ success: true, url: url, note: "Direct link or unsupported extractor" });
    } catch (err) { res.json({ success: false, error: err.message }); }
});

app.get('/', (req, res) => res.send("🚀 Full Potential HDHub4U API is Running on Northflank!"));

app.listen(PORT, () => console.log(`Northflank Server running on port ${PORT}`));
