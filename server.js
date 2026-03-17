const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const CryptoJS = require('crypto-js');

const app = express();
const PORT = process.env.PORT || 8080;

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    next();
});

const HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Cookie": "xla=s4t" };

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
        } catch (e) {}
    }
    return null;
}

// Search API
app.get('/search', async (req, res) => {
    const query = req.query.q;
    const url = `https://search.pingora.fyi/collections/post/documents/search?q=${query}&query_by=post_title,category&query_by_weights=4,2&sort_by=sort_by_date:desc&limit=15&use_cache=true&page=1`;
    try {
        const { data } = await axios.get(url, { headers: { ...HEADERS, "Referer": "https://hdhub4u.rehab" } });
        res.json({ success: true, results: data.hits.map(h => ({ title: h.document.post_title, url: h.document.permalink, posterUrl: h.document.post_thumbnail })) });
    } catch (err) { res.json({ success: false, error: err.message }); }
});

// Load Movie Links
app.get('/load', async (req, res) => {
    const url = req.query.url;
    try {
        const { data } = await axios.get(url, { headers: HEADERS });
        const $ = cheerio.load(data);
        let links =[];
        
        $('h3 a, h4 a').each((i, el) => {
            const text = $(el).text();
            if (/(480|720|1080|2160|4K)/i.test(text)) links.push($(el).attr('href'));
        });
        $('.page-body > div a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && /hdstream4u|hubstream/i.test(href)) links.push(href);
        });
        
        res.json({ success: true, raw_links: [...new Set(links)] });
    } catch (err) { res.json({ success: false, error: err.message }); }
});

// Extract MP4/M3U8
app.get('/extract', async (req, res) => {
    let url = req.query.url;
    try {
        if (url.includes('?id=')) url = await getRedirectLinks(url);

        // 1. HubCloud Extractor
        if (url.toLowerCase().includes('hubcloud') || url.toLowerCase().includes('hubdrive')) {
            let href = url;
            if (!url.includes('hubcloud.php')) {
                const { data } = await axios.get(url, { headers: HEADERS });
                const raw = cheerio.load(data)('#download').attr('href');
                if (raw) href = raw.startsWith('http') ? raw : new URL(url).origin + "/" + raw.replace(/^\//, '');
            }
            const { data: hubData } = await axios.get(href, { headers: HEADERS });
            const $$ = cheerio.load(hubData);
            let extractedLinks =[];
            
            for (let el of $$('a.btn').toArray()) {
                const link = $$(el).attr('href');
                const label = $$(el).text().toLowerCase();
                
                if (label.includes('buzzserver')) {
                    const resp = await axios.get(`${link}/download`, { headers: { Referer: link }, maxRedirects: 0, validateStatus: null });
                    const dlink = resp.headers['hx-redirect'] || resp.headers['hx-redirect'];
                    if (dlink) extractedLinks.push({ server: "BuzzServer", url: dlink });
                } else if (label.includes('pixeldra') || label.includes('pixelserver')) {
                    extractedLinks.push({ server: "Pixeldrain", url: link.includes('download') ? link : `https://pixeldrain.com/api/file/${link.split('/').pop()}?download` });
                } else if (label.includes('fsl') || label.includes('s3') || label.includes('mega')) {
                    extractedLinks.push({ server: label.trim(), url: link });
                }
            }
            return res.json({ success: true, links: extractedLinks });
        }

        // 2. VidStack / HDStream4U Extractor
        if (/vidstack|hubstream|hdstream4u/i.test(url)) {
            const hash = url.split('#').pop().split('/').pop();
            const baseUrl = new URL(url).origin;
            const apiCall = await axios.get(`${baseUrl}/api/v1/video?id=${hash}`, { headers: HEADERS });
            const decryptedText = decryptVidstackAES(apiCall.data.trim());
            if (decryptedText) {
                const m3u8Match = decryptedText.match(/"source":"(.*?)"/);
                if (m3u8Match) return res.json({ success: true, links:[{ server: "VidStack", url: m3u8Match[1].replace(/\\\//g, "/") }] });
            }
        }

        // 3. HubCDN Extractor
        if (url.toLowerCase().includes('hubcdn')) {
            const { data } = await axios.get(url, { headers: HEADERS });
            const encodedMatch = data.match(/reurl\s*=\s*"([^"]+)"/);
            if (encodedMatch) {
                const decodedUrl = base64Decode(encodedMatch[1].split('?r=').pop()).split('link=').pop();
                return res.json({ success: true, links: [{ server: "HubCDN", url: decodedUrl }] });
            }
        }

        res.json({ success: false, error: "No MP4/M3U8 found" });
    } catch (err) { res.json({ success: false, error: err.message }); }
});

app.listen(PORT, () => console.log('Server running!'));
