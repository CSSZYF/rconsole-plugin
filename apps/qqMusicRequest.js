import puppeteer from "../../../lib/puppeteer/puppeteer.js";
import PickSongList from "../model/pick-song.js";
import { formatTime } from '../utils/other.js'
import { COMMON_USER_AGENT, REDIS_YUNZAI_SONGINFO } from "../constants/constant.js";
import { downloadAudio } from "../utils/common.js";
import { redisGetKey, redisSetKey } from "../utils/redis-util.js";
import { checkAndRemoveFile } from "../utils/file.js";
import { sendCustomMusicCard } from "../utils/yunzai-util.js";
import { qqmusic_search, getQQMusicUrl, qqmusic_song_detail } from "../utils/qqmusic-util.js";
import commonModels from "../../../lib/plugins/plugin.js";
import config from "../model/config.js";

export class qqMusicRequest extends plugin {
    constructor() {
        super({
            name: "R插件-QQ音乐",
            dsc: "QQ音乐点歌专门版",
            priority: 300,
            rule: [
                {
                    reg: '^#(qq|QQ)点歌\\s*(.+?)(?:\\s+([12]))?$|^#(qq|QQ)听([1-9][0-9]*)$',
                    fnc: 'qqPickSong'
                },
                {
                    reg: "^#(qq|QQ)播放\\s*(.+?)(?:\\s+([12]))?$",
                    fnc: "qqPlaySong"
                },
                {
                    reg: ".*y\\.qq\\.com\\/n\\/ryqq.*\\/songDetail\\/([a-zA-Z0-9]+).*|.*CQ:json.*QQ音乐.*",
                    fnc: "qqParseUrl"
                }
            ]
        });

        this.toolsConfig = config.getConfig("tools");
        // 加载是否转化群语音
        this.isSendVocal = this.toolsConfig.isSendVocal;
        // 是否开启QQ音乐点歌功能
        this.useQQMusicSongRequest = this.toolsConfig.useQQMusicSongRequest;
        this.qqmusicCookie = this.toolsConfig.qqmusicCookie;
        this.qqmusicAudioQuality = this.toolsConfig.qqmusicAudioQuality || 'size_flac';
        // 加载点歌列表长度
        this.songRequestMaxList = this.toolsConfig.songRequestMaxList;
        // 视频保存路径
        this.defaultPath = this.toolsConfig.defaultPath;
    }

    /**
     * 获取下载路径
     */
    getCurDownloadPath(e = null) {
        if (!e) return this.defaultPath;
        if (e.isGroup) {
            return `${this.defaultPath}${e.group_id}`;
            // return `data/rcmp4/${e.group_id}`;
        }
        return `${this.defaultPath}${e.user_id}`;
    }

    async uploadGroupFile(e, path) {
        try {
            await e.bot.sendApi("upload_group_file", {
                group_id: e.group_id,
                file: path,
                name: path.split('/').pop()
            });
        } catch (error) {
            logger.error('上传群文件失败', error);
        }
    }

    async qqPickSong(e) {
        if (!this.useQQMusicSongRequest) {
            logger.info('当前未开启QQ音乐点歌');
            return false;
        }

        let group_id = e.group_id;
        if (!group_id) return;

        let songInfo = await redisGetKey(REDIS_YUNZAI_SONGINFO) || [];
        const saveId = songInfo.findIndex(item => item.group_id === e.group_id);
        let musicDate = { 'group_id': group_id, data: [] };

        const match = e.msg.match(/^#(qq|QQ)点歌\s*(.+?)(?:\s+([12]))?$|^#(qq|QQ)听([1-9][0-9]*)$/);
        if (match && match[2]) {
            const songKeyWord = match[2];
            let searchCount = this.songRequestMaxList;

            let res = await qqmusic_search(songKeyWord, 1, searchCount, this.qqmusicCookie);
            if (res && res.data && res.data.length > 0) {
                for (const info of res.data) {
                    musicDate.data.push({
                        'id': info.mid,
                        'songName': info.name || info.title,
                        'singerName': info.singer?.[0]?.name,
                        'duration': formatTime(info.interval || info.time_public || 0),
                        'cover': info.album?.mid ? `http://y.gtimg.cn/music/photo_new/T002R300x300M000${info.album.mid}.jpg` : 'https://y.qq.com/favicon.ico',
                        'type': 'qqmusic',
                        'raw': info
                    });
                }

                if (saveId == -1) {
                    songInfo.push(musicDate);
                } else {
                    songInfo[saveId] = musicDate;
                }

                await redisSetKey(REDIS_YUNZAI_SONGINFO, songInfo);
                const data = await new PickSongList(e).getData(musicDate.data);
                let img = await puppeteer.screenshot("pick-song", data);
                e.reply(img);
            } else {
                e.reply('暂未找到你想听的歌哦~');
            }
        } else if (await redisGetKey(REDIS_YUNZAI_SONGINFO) != []) {
            let pickNumberMatch = e.msg.replace(/\s+/g, "").match(/^#(qq|QQ)听(\d+)/);
            if (pickNumberMatch) {
                const pickNumber = pickNumberMatch[2] - 1;
                let songInfo = await redisGetKey(REDIS_YUNZAI_SONGINFO);
                const saveId = songInfo.findIndex(item => item.group_id === e.group_id);

                if (saveId !== -1 && songInfo[saveId].data[pickNumber]) {
                    const selectedSong = songInfo[saveId].data[pickNumber];
                    if (selectedSong.type !== 'qqmusic') {
                        e.reply('你选择的不是QQ音乐，请重新搜索或使用对应的播放指令');
                        return;
                    }
                    this.qqMusicPlay(e, selectedSong.raw, songInfo[saveId].data, pickNumber);
                }
            }
        }
    }

    async qqPlaySong(e) {
        if (!this.useQQMusicSongRequest) {
            logger.info('当前未开启QQ音乐点歌');
            return;
        }

        let group_id = e.group_id;
        if (!group_id) return;

        let songInfo = [];
        const match = e.msg.match(/^#(qq|QQ)播放\s*(.+?)(?:\s+([12]))?$/);
        if (match) {
            const songKeyWord = match[2];
            let res = await qqmusic_search(songKeyWord, 1, 1, this.qqmusicCookie);
            if (res && res.data && res.data.length > 0) {
                const info = res.data[0];
                songInfo.push({
                    'id': info.mid,
                    'songName': info.name || info.title,
                    'singerName': info.singer?.[0]?.name,
                    'duration': formatTime(info.interval || info.time_public || 0),
                    'cover': info.album?.mid ? `http://y.gtimg.cn/music/photo_new/T002R300x300M000${info.album.mid}.jpg` : 'https://y.qq.com/favicon.ico',
                    'type': 'qqmusic',
                    'raw': info
                });
                this.qqMusicPlay(e, info, songInfo, 0);
            } else {
                e.reply('暂未找到你想听的歌哦~')
            }
        }
    }

    // 检查黑名单
    async _checkGlobalBlacklist(e) {
        let blacklistConfig = config.getConfig("resolve");
        // 是否开启全局解析
        let useGlobalResolve = blacklistConfig.useGlobalResolve;
        if (!useGlobalResolve) return false;

        // 获取开关黑名单
        let globalSwithBlacklist = blacklistConfig.globalResolveSwithBlackList || [];
        // 获取黑名单解析正则
        let globalResolveBlacklistRegexObject = blacklistConfig.globalResolveBlackList || {};

        // 检查全局开关黑名单是否包含该群
        if (e.isGroup && globalSwithBlacklist.includes(e.group_id)) {
            logger.info('[R插件]此群已被列入全局解析黑名单，已取消解析请求');
            return false;
        }

        // 检查该群是否在此项解析独立黑名单中
        if (e.isGroup && globalResolveBlacklistRegexObject["qqMusicRequest"]?.includes(e.group_id)) {
            logger.info(`[R插件]此群已被列入qqMusicRequest独立解析黑名单，已取消解析请求`);
            return false;
        }
        return true;
    }

    async qqParseUrl(e) {
        if (!this.useQQMusicSongRequest) return false;

        let shouldResolve = await this._checkGlobalBlacklist(e);
        if (!shouldResolve) return false;

        let songmid = '';
        let title = '';

        // 尝试匹配纯 URL (支持 ryqq 和 ryqq_v2 等)
        let matchUrl = e.msg.match(/y\.qq\.com\/n\/ryqq.*\/songDetail\/([a-zA-Z0-9]+)/);
        if (matchUrl && matchUrl[1]) {
            songmid = matchUrl[1];
        } else if (e.msg.includes('CQ:json') && e.msg.includes('QQ音乐')) {
            // 尝试从分享卡片中提取
            try {
                // 更严谨地提取 data= 之后的花括号内容
                let jsonStrMatch = e.msg.match(/data=({.+?})\]/);
                if (jsonStrMatch && jsonStrMatch[1]) {
                    // 解析转义
                    let cleanStr = jsonStrMatch[1].replace(/&#44;/g, ',').replace(/&amp;/g, '&').replace(/&#91;/g, '[').replace(/&#93;/g, ']');
                    let data = JSON.parse(cleanStr);
                    let jumpUrl = data.meta?.music?.jumpUrl || '';
                    title = data.meta?.music?.title || '';
                    let m = jumpUrl.match(/songDetail\/([a-zA-Z0-9]+)/);
                    if (m) songmid = m[1];
                }
            } catch (err) {
                logger.error('解析QQ音乐卡片JSON失败', err);
            }
        }

        if (!songmid) return false;

        let rawInfo = null;

        // 优先使用直接获取详情的接口
        rawInfo = await qqmusic_song_detail(songmid);

        // 如果获取详情接口失败，再尝试搜索接口兜底
        if (!rawInfo) {
            let query = title ? `${title}` : songmid;
            let res = await qqmusic_search(query, 1, 30, this.qqmusicCookie);
            if (res && res.data && res.data.length > 0) {
                rawInfo = res.data.find(s => s.mid === songmid);
                if (!rawInfo) rawInfo = res.data[0];
            }
        }

        if (!rawInfo) {
            logger.info("解析QQ音乐失败：搜索接口及详情抓取均未能提供该歌曲的数据。");
            return true;
        }

        let songInfo = [{
            'id': rawInfo.mid,
            'songName': rawInfo.name || rawInfo.title,
            'singerName': rawInfo.singer?.[0]?.name,
            'duration': formatTime(rawInfo.interval || rawInfo.time_public || 0),
            'cover': rawInfo.album?.mid ? `http://y.gtimg.cn/music/photo_new/T002R300x300M000${rawInfo.album.mid}.jpg` : 'https://y.qq.com/favicon.ico',
            'type': 'qqmusic',
            'raw': rawInfo
        }];

        // 自动触发点取第一首播放
        this.qqMusicPlay(e, rawInfo, songInfo, 0);
        return true;
    }

    async qqMusicPlay(e, rawInfo, songInfo, pickNumber = 0) {
        const title = songInfo[pickNumber].singerName + '-' + songInfo[pickNumber].songName;
        let ext = 'mp3';
        let url = '';

        try {
            let resp = await getQQMusicUrl(rawInfo, this.qqmusicCookie, this.qqmusicAudioQuality, String(e.user_id || "0"));
            if (resp.url) {
                url = resp.url;
                ext = resp.ext;
            } else {
                logger.error("未能获取到QQ音乐播放链接");
                e.reply("未能获取到QQ音乐播放链接，可能是CK已失效或由于版权下架！");
                return;
            }
        } catch (error) {
            logger.error(error);
            e.reply("获取QQ音乐失败！");
            return;
        }

        let cardSentSuccessfully = false;
        try {
            const jumpUrl = `https://y.qq.com/n/ryqq/songDetail/${rawInfo.mid}`;
            await sendCustomMusicCard(e, jumpUrl, url, songInfo[pickNumber].songName, songInfo[pickNumber].cover);
            cardSentSuccessfully = true;
        } catch (error) {
            logger.error("发送QQ音乐卡片失败，将尝试发送文件/语音", error);
            cardSentSuccessfully = false;
        }

        downloadAudio(url, this.getCurDownloadPath(e), title, 'follow', ext)
            .then(async path => {
                if (!cardSentSuccessfully) {
                    try {
                        await this.uploadGroupFile(e, path);
                        if (ext != 'mp4' && ext != 'flac' && this.isSendVocal) {
                            await e.reply(segment.record(path));
                        }
                    } finally {
                        await checkAndRemoveFile(path);
                    }
                }
            })
            .catch(err => {
                logger.error(`下载QQ音乐失败，错误信息为: ${err}`);
            });
    }
}
