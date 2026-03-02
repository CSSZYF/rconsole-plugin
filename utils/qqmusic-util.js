import axios from "axios";
import crypto from "crypto";

// MD5 计算方法
export function md5(string) {
    return crypto.createHash('md5').update(string).digest('hex');
}

// 解析 Cookie 字符串转 Map
export function getCookieMap(cookie) {
    if (!cookie) return new Map();
    let cookieArray = cookie.replace(/\s*/g, "").split(";");
    let cookieMap = new Map();
    for (let item of cookieArray) {
        let entry = item.split("=");
        if (!entry[0]) continue;
        cookieMap.set(entry[0], entry[1]);
    }
    return cookieMap;
}

/**
 * 搜索 QQ 音乐
 * @param {string} search 搜索关键字
 * @param {number} page 页码
 * @param {number} page_size 每页数量
 * @param {string} cookie QQ音乐 cookie
 * @returns {Promise<{page: number, data: Array}>}
 */
export async function qqmusic_search(search, page = 1, page_size = 10, cookie = '') {
    try {
        let qq_search_json = {
            "comm": { "uin": "0", "authst": "", "ct": 29 },
            "search": {
                "method": "DoSearchForQQMusicMobile",
                "module": "music.search.SearchCgiService",
                "param": {
                    "grp": 1,
                    "num_per_page": page_size,
                    "page_num": page,
                    "query": search,
                    "remoteplace": "miniapp.1109523715",
                    "search_type": 0,
                    "searchid": String(Date.now())
                }
            }
        };

        let url = `https://u.y.qq.com/cgi-bin/musicu.fcg`;
        let response = await axios.post(url, qq_search_json, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)',
                'Content-Type': 'application/json',
                'Cookie': cookie
            }
        });

        let res = response.data;
        if (res.code != '0') {
            return null;
        }
    } catch (err) {
        console.error(err);
    }
    return null;
}

/**
 * 通过 mid 获取 QQ 音乐详细信息
 * @param {string} mid 歌曲 mid
 * @returns {Promise<Object>} 返回歌曲基本信息
 */
export async function qqmusic_song_detail(mid) {
    try {
        let req = {
            "comm": { "ct": 24, "cv": 10000 },
            "songinfo": {
                "method": "get_song_detail_yqq",
                "module": "music.pf_song_detail_svr",
                "param": { "song_mid": mid, "song_type": 0 }
            }
        };

        let response = await axios.post("https://u.y.qq.com/cgi-bin/musicu.fcg", req, {
            headers: { 'Content-Type': 'application/json' }
        });

        let res = response.data;
        if (res.songinfo && res.songinfo.code === 0 && res.songinfo.data && res.songinfo.data.track_info) {
            return res.songinfo.data.track_info;
        }
    } catch (err) {
        console.error("qqmusic_song_detail error:", err);
    }
    return null;
}

/**
 * 获取 QQ 音乐真实播放/下载链接
 * @param {Object} data 音乐基本信息（带有 mid, file 字段等）
 * @param {string} cookieStr Cookie 字符串
 * @param {string} targetQuality 指定获取音质 (例如 'size_flac', 'size_320mp3' 等)，如果不指定默认 'size_flac'
 * @param {string} reqUin 请求者的 uin (由于 Guid 计算可能依赖，通常可以为 0 或 qq 号)
 * @returns {Promise<{url: string, ext: string}>} 返回 链接 以及 扩展名
 */
export async function getQQMusicUrl(data, cookieStr, targetQuality = 'size_flac', reqUin = "0") {
    let play_url = '';
    let ext = 'mp3';

    let cookies = getCookieMap(cookieStr);
    let uin = cookies.get("uin") || cookies.get("wxuin") || "0";
    let qm_keyst = cookies.get("qqmusic_key") || cookies.get("qm_keyst") || "";
    let guid = md5(String(reqUin) + 'music');
    // 如果无请求者身份，直接用时间戳随机一个
    if (reqUin === "0") guid = md5(String(new Date().getTime()));

    let code = md5(`${data.mid}q;z(&l~sdf2!nK`).substring(0, 5).toLocaleUpperCase();
    // 默认兜底试听链接
    play_url = `http://c6.y.qq.com/rsc/fcgi-bin/fcg_pyq_play.fcg?songid=&songmid=${data.mid}&songtype=1&fromtag=50&uin=${reqUin}&code=${code}`;

    let json_body = {
        "comm": {
            "_channelid": "19",
            "_os_version": "6.2.9200-2",
            "authst": qm_keyst,
            "ct": "19",
            "cv": "1891",
            "guid": guid,
            "patch": "118",
            "psrf_access_token_expiresAt": 0,
            "psrf_qqaccess_token": "",
            "psrf_qqopenid": "",
            "psrf_qqunionid": "",
            "tmeAppID": "qqmusic",
            "tmeLoginType": 2, // 2 for qq user, 1 for wechat user
            "uin": uin,
            "wid": "0"
        },
        "req_0": { "module": "vkey.GetVkeyServer", "method": "CgiGetVkey", "param": { "guid": guid, "songmid": [], "songtype": [0], "uin": uin, "ctx": 1 } }
    };

    // 判断是否是微信登录的 Cookie
    if (cookies.get('wxunionid') || cookies.get('wxuin')) {
        json_body.comm.tmeLoginType = 1;
        json_body.comm.wid = uin;
        json_body.comm.psrf_qqunionid = cookies.get('wxunionid') || '';
    } else {
        json_body.comm.tmeLoginType = 2;
        json_body.comm.uin = uin;
        json_body.comm.psrf_qqunionid = cookies.get('psrf_qqunionid') || '';
    }

    let mid = data.mid;
    let media_mid = data.file?.media_mid;
    let songmid = [mid];

    let filename = [];
    let songtype = [];

    if (data.file) {
        // [前缀，后缀，扩展名]
        let quality = [
            ['size_flac', 'F000', 'flac'],
            ['size_320mp3', 'M800', 'mp3'],
            ['size_192ogg', 'O600', 'ogg'],
            ['size_128mp3', 'M500', 'mp3'],
            ['size_96aac', 'C400', 'm4a']
        ];

        let targetIndex = quality.findIndex(q => q[0] === targetQuality);
        if (targetIndex === -1) targetIndex = 0; // Default to highest if not found

        // 尝试从目标画质往下遍历获取存在的画质
        for (let i = targetIndex; i < quality.length; i++) {
            let val = quality[i];
            if (data.file[val[0]] < 1) continue;
            songmid.push(mid);
            songtype.push(0);
            filename.push(`${val[1]}${media_mid}.${val[2]}`);
            ext = val[2];
            break; // 获取到对应的级别的之后就跳出
        }

        if (filename.length == 0) {
            songmid = [mid];
            songtype = [0];
            filename = [`M500${media_mid}.mp3`];
            ext = 'mp3';
        }
    } else {
        songmid = [mid];
        songtype = [0];
        filename = [`M500${media_mid}.mp3`];
        ext = 'mp3';
    }

    json_body.req_0.param.filename = filename;
    json_body.req_0.param.songtype = songtype;
    json_body.req_0.param.songmid = songmid;

    let url = `https://u.y.qq.com/cgi-bin/musicu.fcg`;
    try {
        let response = await axios.post(url, json_body, {
            headers: {
                'Content-Type': 'application/json',
                'Cookie': cookieStr // API 接收 auth 信息
            }
        });

        let res = response.data;
        if (res.req_0 && res.req_0?.code == '0') {
            let midurlinfo = res.req_0.data.midurlinfo;
            let purl = '';
            if (midurlinfo && midurlinfo.length > 0) {
                for (let val of midurlinfo) {
                    purl = val.purl;
                    if (purl) {
                        play_url = 'http://ws.stream.qqmusic.qq.com/' + purl;
                        break;
                    }
                }
            }
        }
    } catch (err) {
        console.error("QQ Music getQQMusicUrl error:", err);
    }

    return { url: play_url, ext: ext };
}
