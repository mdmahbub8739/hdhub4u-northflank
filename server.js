
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const CryptoJS = require('crypto-js');

const app = express();
const PORT = process.env.PORT || 8080;

const DOMAIN = "https://hdhub4u.rehab";
const TMDB_API = "https://wild-surf-4a0d.phisher1.workers.dev";
const TMDB_KEY = "1865f43a0549ca50d341dd9ab8b29f49";
const HEADERS = { 
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0", 
    "Cookie": "xla=s4t" 
};

app.use(express.json());

// ==========================================
// 1. CORE UTILS (Bypass, ROT13, Decryption)
// ==========================================
function pen(value) {
    return value.replace(/[a-zA-Z]/g, c => {
        const base = c <= 'Z' ? 65 : 97;
        return String.fromCharCode((c.charCodeAt(0) - base + 13) % 26 + base);
    });
}

function base64Decode(str) { 
    return Buffer.from(str, 'base64').toString('utf-8'); 
}

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
        const redirectRes = await axios.get(`${wphttp1}?re=${reData}`, { headers: HEADERS });
        const $ = cheerio.load(redirectRes.data);
        return $('body').text().trim();
    } catch (e) { 
        return url; 
    }
}

function decryptVidstackAES(inputHex) {
    const key = CryptoJS.enc.Utf8.parse("kiemtienmua911ca");
    const ivList =["1234567890oiuytr", "0123456789abcdef"];
    const encryptedBase64 = CryptoJS.enc.Base64.stringify(CryptoJS.enc.Hex.parse(inputHex));
    
    for (let ivStr of ivList) {
        try {
            const decrypted = CryptoJS.AES.decrypt(encryptedBase64, key, { 
                iv: CryptoJS.enc.Utf8.parse(ivStr), 
                mode: CryptoJS.mode.CBC, 
                padding: CryptoJS.pad.Pkcs7 
            });
            const result = decrypted.toString(CryptoJS.enc.Utf8);
            if (result) return result;
        } catch (e) { continue; }
    }
    return null;
}

// HubCloud Label Formatting Logic
function getIndexQuality(str) {
    const match = (str || "").match(/(\d{3,4})[pP]/);
    return match ? parseInt(match[1]) : 2160;
}

function cleanTitle(title) {
    let name = title.replace(/\.[a-zA-Z0-9]{2,4}$/, "");
    name = name.replace(/WEB[-_. ]?DL/ig, "WEB-DL")
               .replace(/WEB[-_. ]?RIP/ig, "WEBRIP")
               .replace(/H[ .]?265/ig, "H265")
               .replace(/H[ .]?264/ig, "H264")
               .replace(/DDP[ .]?([0-9]\.[0-9])/ig, "DDP$1");
               
    const parts = name.split(/[\s_.]+/);
    const sourceTags =["WEB-DL", "WEBRIP", "BLURAY", "HDRIP", "DVDRIP", "HDTV", "CAM", "TS", "BRRIP", "BDRIP"];
    const codecTags =["H264", "H265", "X264", "X265", "HEVC", "AVC"];
    const audioTags =["AAC", "AC3", "DTS", "MP3", "FLAC", "DD", "DDP", "EAC3"];
    const hdrTags =["SDR","HDR", "HDR10", "HDR10+", "DV", "DOLBYVISION"];

    let filtered = parts.map(p => p.toUpperCase()).filter(p => {
        if (sourceTags.includes(p) || codecTags.includes(p) || hdrTags.includes(p) || p === 'NF' || p === 'CR') return true;
        if (audioTags.some(a => p.startsWith(a))) return true;
        return false;
    }).map(p => (p === 'DV' || p === 'DOLBYVISION') ? 'DOLBYVISION' : p);

    return[...new Set(filtered)].join(" ");
}

// ==========================================
// 2. CLOUDSTREAM REPLICA ROUTES
// ==========================================

// HOMEPAGE
app.get('/home', async (req, res) => {
    const page = req.query.page || 1;
    const category = req.query.category || ""; 
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

// SEARCH (Pingora)
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

// LOAD DETAILS & TV EPISODE GROUPING
app.get('/load', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.send({ error: "URL required" });

    try {
        const { data } = await axios.get(url, { headers: HEADERS });
        const $ = cheerio.load(data);
        
        const titleRaw = $('.page-body h2[data-ved], h1.page-title span, h2').first().text().trim();
        const seasonMatch = titleRaw.match(/Season\s*(\d+)/i);
        const seasonNumber = seasonMatch ? parseInt(seasonMatch[1]) : null;
        
        const poster = $('main.page-body img.aligncenter').attr('src') || $('meta[property="og:image"]').attr('content');
        const plot = $('.kno-rdesc .kno-rdesc').first().text().trim();
        const isTV = $('h1.page-title span').text().toLowerCase().includes('movie') ? false : true;
        
        // 1. TMDB vs IMDB resolution fallback
        let tmdbId = "";
        const tmdbHref = $("div span a[href*='themoviedb.org']").attr('href');
        
        if (tmdbHref) {
            tmdbId = tmdbHref.split('/').pop().split('-')[0].split('?')[0];
        } else {
            const imdbHref = $("div span a[href*='imdb.com']").attr('href');
            if (imdbHref) {
                const imdbIdOnly = imdbHref.split('title/')[1]?.split('/')[0];
                if (imdbIdOnly) {
                    try {
                        const findRes = await axios.get(`${TMDB_API}/find/${imdbIdOnly}?api_key=${TMDB_KEY}&external_source=imdb_id`);
                        if (isTV && findRes.data.tv_results?.length) tmdbId = findRes.data.tv_results[0].id;
                        else if (!isTV && findRes.data.movie_results?.length) tmdbId = findRes.data.movie_results[0].id;
                    } catch (e) {}
                }
            }
        }

        // 2. Fetch TMDB Metadata
        let tmdbData = null;
        if (tmdbId) {
            const type = isTV ? "tv" : "movie";
            try {
                const tmdbRes = await axios.get(`${TMDB_API}/${type}/${tmdbId}?api_key=${TMDB_KEY}&append_to_response=credits,external_ids`);
                tmdbData = tmdbRes.data;
            } catch (e) {}
        }

        // 3. Extract Streams and Group Episodes
        let resultData = {
            success: true,
            title: tmdbData?.name || tmdbData?.title || titleRaw,
            isTvSeries: isTV,
            posterUrl: tmdbData?.poster_path ? `https://image.tmdb.org/t/p/original${tmdbData.poster_path}` : poster,
            plot: tmdbData?.overview || plot,
            rating: tmdbData?.vote_average
        };

        if (!isTV) {
            let links =[];
            $('h3 a, h4 a, .page-body > div a').each((i, el) => {
                const text = $(el).text();
                const href = $(el).attr('href');
                if (href && /480|720|1080|2160|4K|hdstream4u|hubstream/i.test(text + href)) links.push(href);
            });
            resultData.links = [...new Set(links)];
        } else {
            // Complex TV Series Grouping
            const epLinksMap = {};
            const elements = $('h3, h4').toArray();
            
            for (let el of elements) {
                const $el = $(el);
                const blockText = $el.text();
                const epNumMatch = blockText.match(/EPiSODE\s*(\d+)/i);
                const epNumFromTitle = epNumMatch ? parseInt(epNumMatch[1]) : null;
                
                const baseLinks = $el.find('a[href]').map((i, a) => $(a).attr('href')).get().filter(l => l.trim() !== "");
                const isDirectLinkBlock = /1080|720|4K|2160/i.test(blockText) && $el.find('a').length > 0;

                if (isDirectLinkBlock) {
                    for (let link of baseLinks) {
                        try {
                            const resolvedUrl = await getRedirectLinks(link.trim());
                            const episodeDocRes = await axios.get(resolvedUrl, { headers: HEADERS });
                            const $epDoc = cheerio.load(episodeDocRes.data);
                            
                            $epDoc('h5 a').each((i, a) => {
                                const linkText = $(a).text();
                                const linkHref = $(a).attr('href');
                                const epNum = linkText.match(/Episode\s*(\d+)/i);
                                if (epNum && linkHref) {
                                    const num = parseInt(epNum[1]);
                                    if (!epLinksMap[num]) epLinksMap[num] = new Set();
                                    epLinksMap[num].add(linkHref);
                                }
                            });
                        } catch (err) {}
                    }
                } else if (epNumFromTitle !== null) {
                    const allLinks = new Set(baseLinks);
                    if (el.tagName.toLowerCase() === 'h4') {
                        $el.nextUntil('hr').each((i, sib) => {
                            $(sib).find('a[href]').each((j, a) => {
                                const href = $(a).attr('href');
                                if (href) allLinks.add(href);
                            });
                        });
                    }
                    if (allLinks.size > 0) {
                        if (!epLinksMap[epNumFromTitle]) epLinksMap[epNumFromTitle] = new Set();
                        allLinks.forEach(l => epLinksMap[epNumFromTitle].add(l));
                    }
                }
            }

            // Bind to TMDB episode metadata if available
            let tmdbEpisodes =[];
            if (seasonNumber && tmdbId) {
                try {
                    const seasonRes = await axios.get(`${TMDB_API}/tv/${tmdbId}/season/${seasonNumber}?api_key=${TMDB_KEY}`);
                    tmdbEpisodes = seasonRes.data.episodes ||[];
                } catch(e) {}
            }

            resultData.episodes = Object.keys(epLinksMap).map(epNum => {
                const num = parseInt(epNum);
                const info = tmdbEpisodes.find(e => e.episode_number === num);
                return {
                    name: info?.name || `Episode ${num}`,
                    season: seasonNumber,
                    episode: num,
                    posterUrl: info?.still_path ? `https://image.tmdb.org/t/p/original${info.still_path}` : null,
                    description: info?.overview || null,
                    links: Array.from(epLinksMap[epNum])
                };
            });
        }
        
        res.json(resultData);
    } catch (err) { res.json({ success: false, error: err.message }); }
});

// FULL EXTRACTOR (HubCloud, VidStack, HubCDN, HubDrive)
app.get('/extract', async (req, res) => {
    let url = req.query.url;
    if (!url) return res.send({ error: "URL required" });

    try {
        if (url.includes('?id=')) url = await getRedirectLinks(url);

        // 1. HubDrive specific redirect logic
        if (url.toLowerCase().includes('hubdrive.space')) {
            const { data } = await axios.get(url, { headers: HEADERS });
            const $ = cheerio.load(data);
            const href = $('.btn.btn-primary.btn-user.btn-success1.m-1').attr('href');
            if (href) {
                if (href.toLowerCase().includes('hubcloud')) url = href;
                else return res.json({ success: true, source: "HubDrive", links: [{ url: href }] });
            }
        }

        // 2. HubCloud Logic (Full implementation with Quality & Size Metadata)
        if (url.toLowerCase().includes('hubcloud')) {
            const { data } = await axios.get(url, { headers: HEADERS });
            const $ = cheerio.load(data);
            const raw = $('#download').attr('href');
            const baseUrl = new URL(url).origin;
            let href = raw?.startsWith('http') ? raw : `${baseUrl}/${raw?.replace(/^\//, '')}`;
            
            if (href) {
                const hubDoc = await axios.get(href, { headers: HEADERS });
                const $$ = cheerio.load(hubDoc.data);
                
                const size = $$('i#size').first().text().trim();
                const header = $$('div.card-header').first().text().trim();
                const headerDetails = cleanTitle(header);
                const quality = getIndexQuality(header);
                const labelExtras = [headerDetails, size].filter(Boolean).map(x => `[${x}]`).join('');
                
                let extractedLinks =[];
                
                const buttons = $$('a.btn').toArray();
                for (let el of buttons) {
                    const link = $$(el).attr('href');
                    const label = $$(el).text().toLowerCase();

                    if (label.includes('pixeldrain') || label.includes('pixelserver')) {
                        const linkBase = new URL(link).origin;
                        const finalUrl = link.includes('download') ? link : `${linkBase}/api/file/${link.split('/').pop()}?download`;
                        extractedLinks.push({ server: "Pixeldrain", quality, metadata: labelExtras, url: finalUrl });
                    } else if (label.includes('buzzserver')) {
                        try {
                            const resp = await axios.get(`${link}/download`, { 
                                headers: { ...HEADERS, Referer: link },
                                maxRedirects: 0,
                                validateStatus: s => s < 400
                            });
                            const dlink = resp.headers['hx-redirect'] || resp.headers['location'];
                            if (dlink) extractedLinks.push({ server: "BuzzServer", quality, metadata: labelExtras, url: dlink });
                        } catch(e) {}
                    } else if (label.includes('fsl') || label.includes('s3') || label.includes('mega')) {
                        const srvName = label.includes('fsl') ? "FSL Server" : (label.includes('mega') ? "Mega Server" : "S3 Server");
                        extractedLinks.push({ server: srvName, quality, metadata: labelExtras, url: link });
                    }
                }
                return res.json({ success: true, source: "HubCloud", links: extractedLinks });
            }
        }

        // 3. VidStack Logic (With Subtitles Support)
        if (url.toLowerCase().includes('vidstack.io') || url.toLowerCase().includes('hubstream')) {
            const hash = url.split('#').pop().split('/').pop();
            const baseUrl = new URL(url).origin;
            const apiCall = await axios.get(`${baseUrl}/api/v1/video?id=${hash}`, { headers: HEADERS });
            
            const decryptedText = decryptVidstackAES(apiCall.data.trim());
            if (decryptedText) {
                const m3u8Match = decryptedText.match(/"source":"(.*?)"/);
                const m3u8 = m3u8Match ? m3u8Match[1].replace(/\\\//g, "/") : "";
                
                let subtitles =[];
                const subtitleSectionMatch = decryptedText.match(/"subtitle":\{(.*?)\}/);
                if (subtitleSectionMatch) {
                    const subSection = subtitleSectionMatch[1];
                    const subRegex = /"([^"]+)":\s*"([^"]+)"/g;
                    let m;
                    while ((m = subRegex.exec(subSection)) !== null) {
                        const lang = m[1];
                        const rawPath = m[2].split('#')[0];
                        if (rawPath) {
                            subtitles.push({ lang, url: `${baseUrl}${rawPath.replace(/\\\//g, "/")}` });
                        }
                    }
                }
                
                return res.json({ 
                    success: true, 
                    source: "VidStack", 
                    isM3U8: true, 
                    url: m3u8.replace("https", "http"), 
                    subtitles 
                });
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

app.get('/', (req, res) => res.send("🚀 HDHub4U Full-Feature API Running Perfectly on Northflank!"));

app.listen(PORT, () => console.log(`Northflank Server running on port ${PORT}`));
