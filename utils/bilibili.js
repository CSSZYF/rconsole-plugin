import axios from 'axios'
import { exec, spawn } from 'child_process';
import child_process from 'node:child_process'
import fs from "node:fs";
import path from "path";
import qrcode from "qrcode"
import util from "util";
import { BILI_RESOLUTION_LIST } from "../constants/constant.js";
import {
    BILI_BANGUMI_STREAM,
    BILI_BVID_TO_CID,
    BILI_DYNAMIC,
    BILI_EP_INFO,
    BILI_PLAY_STREAM,
    BILI_SCAN_CODE_DETECT,
    BILI_SCAN_CODE_GENERATE,
    BILI_VIDEO_INFO
} from "../constants/tools.js";
import { mkdirIfNotExists } from "./file.js";

export const BILI_HEADER = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
    referer: 'https://www.bilibili.com',
}

/**
 * 从cookie字符串中提取SESSDATA的值
 * 支持两种格式：
 * 1. 直接SESSDATA值：abc123%2C...
 * 2. 完整cookie字符串：CURRENT_QUALITY=120;...;SESSDATA=abc123%2C...;...
 * @param {string} cookieOrSessData cookie字符串或SESSDATA值
 * @returns {string} 提取的SESSDATA值
 */
export function extractSessData(cookieOrSessData) {
    if (!cookieOrSessData) return '';

    // 如果包含 SESSDATA= 则是完整cookie字符串，需要提取
    if (cookieOrSessData.includes('SESSDATA=')) {
        const match = cookieOrSessData.match(/SESSDATA=([^;]+)/);
        if (match && match[1]) {
            logger.debug(`[R插件][SESSDATA] 从完整cookie中提取SESSDATA`);
            return match[1];
        }
    }

    // 否则认为是直接的SESSDATA值
    return cookieOrSessData;
}

/**
 * 根据请求的画质(qn)计算对应的fnval值
 * fnval是二进制标志位组合：16(DASH) | 特定功能 | 2048(AV1)
 * @param {number} qn 画质代码
 * @param {boolean} smartResolution 是否启用智能分辨率
 * @returns {{fnval: number, fourk: number}} fnval和fourk参数
 */
export function calculateFnval(qn, smartResolution = false) {
    const baseDash = 16;    // DASH格式
    const av1Codec = 2048;  // AV1编码

    let fnval = baseDash | av1Codec; // 基础：DASH + AV1
    let fourk = 0;

    // 智能分辨率：请求所有可能的画质（8K+4K+HDR+杜比视界+AV1）
    if (smartResolution) {
        fnval = baseDash | av1Codec | 1024 | 128 | 64 | 512; // DASH + AV1 + 8K + 4K + HDR + 杜比
        fourk = 1;
        return { fnval, fourk };
    }

    switch (parseInt(qn)) {
        case 127: // 8K
            fnval |= 1024; // 需要8K支持
            fourk = 1;
            break;
        case 126: // 杜比视界
            fnval |= 512; // 需要杜比视界
            fourk = 1;
            break;
        case 125: // HDR
            fnval |= 64; // 需要HDR
            fourk = 1;
            break;
        case 120: // 4K
            fnval |= 128; // 需要4K支持
            fourk = 1;
            break;
        case 116: // 1080P60高帧率
        case 112: // 1080P+高码率
        case 80:  // 1080P
        case 74:  // 720P60高帧率
        case 64:  // 720P
        case 32:  // 480P
        case 16:  // 360P
            // 普通画质只需要基础DASH+AV1
            break;
        default:
            logger.warn(`[R插件][fnval计算] 未知的QN值: ${qn}，使用默认fnval`);
            break;
    }

    return { fnval, fourk };
}

/**
 * 下载单个bili文件
 * @param url                       下载链接
 * @param fullFileName              文件名
 * @param progressCallback          下载进度
 * @param biliDownloadMethod        下载方式 {BILI_DOWNLOAD_METHOD}
 * @param videoDownloadConcurrency  视频下载并发
 * @returns {Promise<any>}
 */
export async function downloadBFile(url, fullFileName, progressCallback, biliDownloadMethod = 0, videoDownloadConcurrency = 1) {
    if (biliDownloadMethod === 0) {
        // 原生
        return normalDownloadBFile(url, fullFileName, progressCallback);
    }
    if (biliDownloadMethod === 1) {
        // 性能 Aria2
        return aria2DownloadBFile(url, fullFileName, progressCallback, videoDownloadConcurrency);
    } else {
        // 轻量
        return axelDownloadBFile(url, fullFileName, progressCallback, videoDownloadConcurrency);
    }
}

/**
 * 正常下载
 * @param url
 * @param fullFileName
 * @param progressCallback
 * @returns {Promise<{fullFileName: string, totalLen: number}>}
 */
async function normalDownloadBFile(url, fullFileName, progressCallback) {
    const startTime = Date.now();
    // 防御性URL解析
    let cdnHost = 'unknown';
    try {
        cdnHost = new URL(url).hostname;
    } catch (e) {
        logger.warn(`[R插件][BILI下载] 无法解析CDN主机名: ${e.message}`);
    }
    const maxRetries = 3;
    const baseRetryDelay = 1000; // 指数退避基础延迟

    for (let retry = 0; retry <= maxRetries; retry++) {
        try {
            return await axios
                .get(url, {
                    responseType: 'stream',
                    headers: {
                        ...BILI_HEADER
                    },
                })
                .then(({ data, headers }) => {
                    let currentLen = 0;
                    const totalLen = headers['content-length'];

                    return new Promise((resolve, reject) => {
                        data.on('data', ({ length }) => {
                            currentLen += length;
                            progressCallback?.(currentLen / totalLen);
                        });

                        data.on('error', reject);

                        data.pipe(
                            fs.createWriteStream(fullFileName).on('finish', () => {
                                const duration = ((Date.now() - startTime) / 1000).toFixed(2);
                                const sizeMB = (totalLen / 1024 / 1024).toFixed(2);
                                const speed = (sizeMB / duration).toFixed(2);
                                logger.info(`[R插件][下载完成] CDN: ${cdnHost}, 大小: ${sizeMB}MB, 用时: ${duration}s, 速度: ${speed}MB/s`);
                                resolve({
                                    fullFileName,
                                    totalLen,
                                });
                            }).on('error', reject),
                        );
                    });
                });
        } catch (err) {
            if (retry < maxRetries) {
                // 指数退避: 1s, 2s, 4s
                const delay = baseRetryDelay * Math.pow(2, retry);
                logger.warn(`[R插件][BILI下载] 下载失败，${delay / 1000}秒后重试 (${retry + 1}/${maxRetries}): ${err.message}`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                logger.error(`[R插件][BILI下载] 下载最终失败: ${err.message}`);
                throw err;
            }
        }
    }
}

/**
 * 使用Aria2下载
 * @param url
 * @param fullFileName
 * @param progressCallback
 * @param videoDownloadConcurrency
 * @returns {Promise<{fullFileName: string, totalLen: number}>}
 */
async function aria2DownloadBFile(url, fullFileName, progressCallback, videoDownloadConcurrency) {
    const startTime = Date.now();
    // 防御性URL解析
    let cdnHost = 'unknown';
    try {
        cdnHost = new URL(url).hostname;
    } catch (e) {
        logger.warn(`[R插件][Aria2] 无法解析CDN主机名: ${e.message}`);
    }

    return new Promise((resolve, reject) => {
        logger.info(`[R插件][Aria2下载] CDN: ${cdnHost}, 正在使用Aria2进行下载!`);
        // 构建aria2c命令
        const aria2cArgs = [
            '--file-allocation=none',  // 避免预分配文件空间
            '--continue',              // 启用暂停支持
            '-o', fullFileName,        // 指定输出文件名
            '--console-log-level=warn', // 减少日志 verbosity
            '--download-result=hide',   // 隐藏下载结果概要
            '--header', 'referer: https://www.bilibili.com', // 添加自定义标头
            `--max-connection-per-server=${videoDownloadConcurrency}`, // 每个服务器的最大连接数
            `--split=${videoDownloadConcurrency}`,               // 分成 6 个部分进行下载
            url
        ];

        // Spawn aria2c 进程
        const aria2c = spawn('aria2c', aria2cArgs);

        let totalLen = 0;
        let currentLen = 0;

        // 处理aria2c标准输出数据以捕获进度（可选）
        aria2c.stdout.on('data', (data) => {
            const output = data.toString();
            const match = output.match(/\((\d+)\s*\/\s*(\d+)\)/);
            if (match) {
                currentLen = parseInt(match[1], 10);
                totalLen = parseInt(match[2], 10);
                progressCallback?.(currentLen / totalLen);
            }
        });

        // 处理aria2c的stderr以捕获错误
        aria2c.stderr.on('data', (data) => {
            console.error(`aria2c error: ${data}`);
        });

        // 处理进程退出
        aria2c.on('close', (code) => {
            if (code === 0) {
                const duration = ((Date.now() - startTime) / 1000).toFixed(2);
                const actualSize = fs.existsSync(fullFileName) ? fs.statSync(fullFileName).size : totalLen;
                const sizeMB = (actualSize / 1024 / 1024).toFixed(2);
                const speed = (sizeMB / duration).toFixed(2);
                logger.info(`[R插件][Aria2下载完成] CDN: ${cdnHost}, 大小: ${sizeMB}MB, 用时: ${duration}s, 速度: ${speed}MB/s`);
                resolve({ fullFileName, totalLen: actualSize });
            } else {
                reject(new Error(`aria2c exited with code ${code}`));
            }
        });
    });
}

/**
 * 使用 C 语言写的轻量级下载工具 Axel 进行下载
 * @param url
 * @param fullFileName
 * @param progressCallback
 * @param videoDownloadConcurrency
 * @returns {Promise<{fullFileName: string, totalLen: number}>}
 */
async function axelDownloadBFile(url, fullFileName, progressCallback, videoDownloadConcurrency) {
    const startTime = Date.now();
    // 防御性URL解析
    let cdnHost = 'unknown';
    try {
        cdnHost = new URL(url).hostname;
    } catch (e) {
        logger.warn(`[R插件][Axel] 无法解析CDN主机名: ${e.message}`);
    }

    return new Promise((resolve, reject) => {
        // 构建路径
        fullFileName = path.resolve(fullFileName);

        // 构建 -H 参数
        const headerParams = Object.entries(BILI_HEADER).map(
            ([key, value]) => `--header="${key}: ${value}"`
        ).join(' ');

        let command = '';
        let downloadTool = 'wget';
        if (videoDownloadConcurrency === 1) {
            // wget 命令
            command = `${downloadTool} -O ${fullFileName} ${headerParams} '${url}'`;
        } else {
            // AXEL 命令行
            downloadTool = 'axel';
            command = `${downloadTool} -n ${videoDownloadConcurrency} -o ${fullFileName} ${headerParams} '${url}'`;
        }

        // 执行命令
        const axel = exec(command);
        logger.info(`[R插件][${downloadTool}] CDN: ${cdnHost}, 下载方式: ${downloadTool === 'wget' ? '单线程' : '多线程'}`);

        axel.stdout.on('data', (data) => {
            const match = data.match(/(\d+)%/);
            if (match) {
                const progress = parseInt(match[1], 10) / 100;
                progressCallback?.(progress);
            }
        });

        axel.stderr.on('data', (data) => {
            logger.info(`[R插件][${downloadTool}]: ${data}`);
        });

        axel.on('close', (code) => {
            if (code === 0) {
                const totalLen = fs.statSync(fullFileName).size;
                const duration = ((Date.now() - startTime) / 1000).toFixed(2);
                const sizeMB = (totalLen / 1024 / 1024).toFixed(2);
                const speed = (sizeMB / duration).toFixed(2);
                logger.info(`[R插件][${downloadTool}下载完成] CDN: ${cdnHost}, 大小: ${sizeMB}MB, 用时: ${duration}s, 速度: ${speed}MB/s`);
                resolve({
                    fullFileName,
                    totalLen,
                });
            } else {
                reject(new Error(`[R插件][${downloadTool}] 错误：${code}`));
            }
        });
    });
}

/**
 * 获取下载链接
 * @param url
 * @param SESSDATA
 * @param qn 画质参数
 * @param duration 视频时长（秒），如果提供则用于文件大小估算
 * @param smartResolution 是否启用智能分辨率
 * @param fileSizeLimit 文件大小限制（MB）
 * @param preferredCodec 用户选择的编码：auto, av1, hevc, avc
 * @param cdnMode CDN模式：0=自动选择, 1=使用原始CDN, 2=强制镜像站
 * @param minResolution 最低分辨率value值，默认360P(10)，参考BILI_RESOLUTION_LIST
 * @returns {Promise<any>}
 */
export async function getDownloadUrl(url, SESSDATA, qn, duration = 0, smartResolution = false, fileSizeLimit = 100, preferredCodec = 'auto', cdnMode = 0, minResolution = 10) {
    let videoId = "";
    let cid = "";
    let isBangumi = false;
    let epId = "";

    // 检查是否是番剧URL
    const epMatch = /bangumi\/play\/ep(\d+)/.exec(url);
    if (epMatch) {
        isBangumi = true;
        epId = epMatch[1];
        logger.info(`[R插件][BILI下载] 检测到番剧链接，EP ID: ${epId}`);
        const epInfo = await getBangumiVideoInfo(epId);
        if (!epInfo) {
            throw new Error(`无法获取番剧信息，EP ID: ${epId}`);
        }
        videoId = epInfo.bvid;
        cid = epInfo.cid;
    } else {
        // 普通视频URL
        const videoMatch = /video\/[^\?\/ ]+/.exec(url);
        if (!videoMatch) {
            throw new Error(`无法识别的URL格式: ${url}`);
        }
        videoId = videoMatch[0].split("/")[1];

        // 提取URL中的p参数（分P号）
        let pParam = null;
        try {
            const urlObj = new URL(url.startsWith('http') ? url : 'https://' + url);
            const pValue = urlObj.searchParams.get('p');
            if (pValue) {
                pParam = parseInt(pValue, 10);
            }
        } catch (e) {
            logger.debug(`[R插件][BILI下载] URL解析P参数失败: ${e.message}`);
        }

        // AV号特殊处理
        if (videoId.toLowerCase().startsWith('av')) {
            // 将 AV 转换为 BV
            const { bvid, cid: newCid, pages } = await getVideoInfo(url);
            videoId = bvid;
            // 如果有P参数且页数足够，获取对应分P的CID
            if (pParam && pages && pages.length >= pParam && pParam > 0) {
                cid = pages[pParam - 1].cid;
                logger.debug(`[R插件][BILI下载] AV号分P${pParam}, CID: ${cid}`);
            } else {
                cid = newCid;
            }
        } else if (pParam && pParam > 0) {
            // BV号且有分P参数，获取对应分P的CID
            cid = await getPageCid(videoId, pParam);
        }
        // 如果cid仍为空，getBiliVideoWithSession会通过fetchCID获取P1的CID
    }

    // 转换画质数字为分辨率
    let qualityText;
    switch (parseInt(qn)) {
        case 127: qualityText = "8K超高清"; break;
        case 126: qualityText = "杜比视界"; break;
        case 125: qualityText = "HDR真彩"; break;
        case 120: qualityText = "4K超清"; break;
        case 116: qualityText = "1080P60高帧率"; break;
        case 112: qualityText = "1080P+高码率"; break;
        case 80: qualityText = "1080P高清"; break;
        case 74: qualityText = "720P60高帧率"; break;
        case 64: qualityText = "720P高清"; break;
        case 32: qualityText = "480P清晰"; break;
        case 16: qualityText = "360P流畅"; break;
        default: qualityText = `未知画质(QN:${qn})`; break;
    }
    logger.debug(`[R插件][BILI下载] 视频ID: ${videoId}, 画质: ${qualityText}`);

    let streamData;
    let streamType = 'dash'; // 默认为dash格式

    if (isBangumi) {
        // 番剧使用专门的API，可能返回dash或durl格式
        const bangumiResult = await getBangumiBiliVideoWithSession(epId, cid, SESSDATA, qn, smartResolution);
        streamType = bangumiResult.type;
        // 保存完整的bangumiResult，包含result对象用于提取timelength
        streamData = bangumiResult;

        // 如果是DURL格式，直接返回视频URL（不需要音频）
        if (streamType === 'durl') {
            const durlData = streamData.durl;
            if (!durlData || durlData.length === 0) {
                logger.error(`[R插件][BILI下载] 番剧DURL数据为空`);
                return { videoUrl: null, audioUrl: null };
            }
            const firstDurl = durlData[0];
            const videoUrl = selectAndAvoidMCdnUrl(firstDurl.url, firstDurl.backup_url || []);
            logger.info(`[R插件][BILI下载] 番剧DURL格式，大小: ${Math.round(firstDurl.size / 1024 / 1024)}MB, 时长: ${Math.round(firstDurl.length / 1000)}秒`);
            return { videoUrl, audioUrl: null };
        }
    } else {
        // 普通视频
        streamData = await getBiliVideoWithSession(videoId, cid, SESSDATA, qn, smartResolution);

        // 检查是否是durl格式（试看视频）
        if (streamData._type === 'durl') {
            const isPreview = streamData._isPreview;
            const supportFormats = streamData.supportFormats || [];
            let currentQuality = streamData.quality;
            let currentDurl = streamData.durl?.[0];

            if (!currentDurl) {
                logger.error(`[R插件][BILI下载] 试看视频无可用durl数据`);
                return { videoUrl: null, audioUrl: null };
            }

            // 智能分辨率：如果超限则依次尝试更低清晰度
            if (smartResolution && currentDurl.size) {
                const acceptQuality = (streamData.acceptQuality || []).sort((a, b) => b - a);

                for (const tryQn of acceptQuality) {
                    // 跳过已经请求过的或更高的清晰度
                    if (tryQn > currentQuality) continue;

                    // 如果不是当前清晰度，需要重新请求
                    if (tryQn !== currentQuality) {
                        try {
                            const newData = await getBiliVideoWithSession(videoId, cid, SESSDATA, tryQn, false);
                            if (newData._type === 'durl' && newData.durl?.[0]) {
                                currentDurl = newData.durl[0];
                                currentQuality = newData.quality;
                            } else continue;
                        } catch { continue; }
                    }

                    const sizeMB = currentDurl.size / (1024 * 1024);
                    if (sizeMB <= fileSizeLimit) {
                        const formatInfo = supportFormats.find(f => f.quality === currentQuality);
                        logger.info(`[R插件][BILI下载] 试看视频选择: ${formatInfo?.new_description || 'QN' + currentQuality}, 大小: ${Math.round(sizeMB)}MB`);
                        break;
                    }
                }

                // 检查最终是否仍超限
                const finalSizeMB = currentDurl.size / (1024 * 1024);
                if (finalSizeMB > fileSizeLimit) {
                    return { videoUrl: null, audioUrl: null, skipReason: `试看视频最低清晰度${Math.round(finalSizeMB)}MB超过限制${fileSizeLimit}MB` };
                }
            }

            const videoUrl = selectAndAvoidMCdnUrl(currentDurl.url, currentDurl.backup_url || [], cdnMode);
            const durationSec = Math.round((currentDurl.length || 0) / 1000);
            const qualityDesc = supportFormats.find(f => f.quality === currentQuality)?.new_description || `QN${currentQuality}`;

            logger.info(`[R插件][BILI下载] ${isPreview ? '❗试看视频' : 'DURL视频'}: ${qualityDesc}, ${durationSec}秒`);
            return { videoUrl, audioUrl: null, isPreview, previewDuration: durationSec, qualityDesc };
        }
    }

    // 以下是DASH格式处理逻辑
    // 番剧的DASH数据在streamData.data中，普通视频直接在streamData中
    const dashData = isBangumi ? streamData.data : streamData;
    const { video, audio } = dashData;

    // 根据请求的画质选择对应的视频流
    let targetHeight;
    switch (parseInt(qn)) {
        case 127: targetHeight = 4320; break; // 8K
        case 126: targetHeight = 2160; break; // 杜比视界 (通常是4K)
        case 125: targetHeight = 2160; break; // HDR (通常是4K)
        case 120: targetHeight = 2160; break; // 4K
        case 116: targetHeight = 1080; break; // 1080P60高帧率
        case 112: targetHeight = 1080; break; // 1080P+高码率
        case 80: targetHeight = 1080; break;  // 1080P
        case 74: targetHeight = 720; break;   // 720P60高帧率
        case 64: targetHeight = 720; break;   // 720P
        case 32: targetHeight = 480; break;   // 480P
        case 16: targetHeight = 360; break;   // 360P
        default:
            // 未知QN，尝试从视频流中选择最高画质
            targetHeight = Math.max(...video.map(v => v.height));
            logger.warn(`[R插件][BILI下载] 未知的QN值: ${qn}，使用最高可用分辨率: ${targetHeight}p`);
            break;
    }

    // 获取目标分辨率的所有视频流
    let matchingVideos;

    // 智能分辨率：使用所有可用画质，从最高开始选择
    if (smartResolution) {
        matchingVideos = video; // 使用所有视频流
    } else {
        // 非智能分辨率：按请求画质筛选
        matchingVideos = video.filter(v => v.height === targetHeight);

        // 如果找不到完全匹配的，找最接近但不超过目标分辨率的
        if (matchingVideos.length === 0) {
            // 记录所有可用的分辨率
            const availableHeights = [...new Set(video.map(v => v.height))].sort((a, b) => b - a);
            logger.warn(`[R插件][BILI下载] ⚠️ 请求的${targetHeight}p画质不可用，API返回的最高画质: ${availableHeights[0]}p`);
            logger.info(`[R插件][BILI下载] API可用分辨率列表: ${availableHeights.join('p, ')}p`);

            matchingVideos = video
                .filter(v => v.height <= targetHeight)
                .sort((a, b) => b.height - a.height);

            // 获取最高的可用分辨率的所有视频流
            if (matchingVideos.length > 0) {
                const maxHeight = matchingVideos[0].height;
                matchingVideos = matchingVideos.filter(v => v.height === maxHeight);
            }
        }

        // 如果还是找不到，使用所有可用的最低分辨率视频流
        if (matchingVideos.length === 0) {
            const minHeight = Math.min(...video.map(v => v.height));
            matchingVideos = video.filter(v => v.height === minHeight);
            logger.error(`[R插件][BILI下载] 所有视频流都高于请求画质，使用最低可用: ${minHeight}p`);
        }
    }

    // 智能选择最佳视频流：优先编码AV1>HEVC>AVC，并考虑文件大小限制
    let videoData;
    if (matchingVideos.length > 0) {

        // 估算文件大小（带宽 * 时长）
        const estimateSize = (stream, audioStream, timelength) => {
            const videoBandwidth = stream.bandwidth || 0;
            const audioBandwidth = audioStream?.bandwidth || 0;
            const totalBandwidth = videoBandwidth + audioBandwidth;
            // bandwidth单位是bps，除以8得到字节/秒
            const bytesPerSecond = totalBandwidth / 8;
            // 优先使用timelength（毫秒），否则使用duration（秒）
            const durationSeconds = timelength ? (timelength / 1000) : (stream.duration || audioStream?.duration || 0);
            if (durationSeconds === 0) {
                logger.warn(`[R插件][BILI下载] 无法获取视频时长，文件大小估算可能不准确`);
            }
            return (bytesPerSecond * durationSeconds) / (1024 * 1024); // 转换为MB
        };

        // 按照编码优先级排序：av1 > hevc > avc
        // 注意：av01表示AV1, hev1表示HEVC, avc1表示AVC
        const getCodecType = (codecs) => {
            const codecLower = codecs.toLowerCase();
            if (codecLower.includes('av01') || codecLower.includes('av1')) return 'av1';
            if (codecLower.includes('hev1') || codecLower.includes('hevc')) return 'hevc';
            if (codecLower.includes('avc1') || codecLower.includes('avc')) return 'avc';
            return 'unknown';
        };

        // 根据用户选择的编码设置优先级
        let codecPriority;
        switch (preferredCodec) {
            case 'av1':
                codecPriority = { av1: 1, hevc: 2, avc: 3, unknown: 999 };
                logger.info(`[R插件][BILI下载] 用户指定编码: AV1（若不可用则降级）`);
                break;
            case 'hevc':
                codecPriority = { av1: 2, hevc: 1, avc: 3, unknown: 999 };
                logger.info(`[R插件][BILI下载] 用户指定编码: HEVC（若不可用则降级）`);
                break;
            case 'avc':
                codecPriority = { av1: 2, hevc: 3, avc: 1, unknown: 999 };
                logger.info(`[R插件][BILI下载] 用户指定编码: AVC（若不可用则降级）`);
                break;
            default:
                // auto: 默认优先级 av1 > hevc > avc
                codecPriority = { av1: 1, hevc: 2, avc: 3, unknown: 999 };
                break;
        }
        const sortedVideos = matchingVideos.sort((a, b) => {
            const codecTypeA = getCodecType(a.codecs);
            const codecTypeB = getCodecType(b.codecs);
            const priorityA = codecPriority[codecTypeA];
            const priorityB = codecPriority[codecTypeB];

            // 优先使用更高优先级的编码（数字越小越优先）
            if (priorityA !== priorityB) {
                return priorityA - priorityB;
            }

            // 相同编码下，默认选择码率较低的（文件更小）
            // 只有明确请求1080P+高码率(QN=112)时才选择高码率
            return a.bandwidth - b.bandwidth; // 默认：码率从低到高
        });

        // 获取音频流和视频时长用于估算总大小
        const audioData = audio?.[0];

        // 尝试从API响应获取timelength（毫秒）
        // 优先使用传入的duration参数（秒）
        let timelength = duration > 0 ? duration * 1000 : 0;

        // 如果没有传入duration，尝试从API响应获取
        if (timelength === 0) {
            // 不同类型视频的响应结构不同
            if (isBangumi && streamData?.result?.timelength) {
                // 番剧：使用 result.timelength
                timelength = streamData.result.timelength;
                logger.info(`[R插件][BILI下载] 从番剧API获取时长: ${Math.round(timelength / 1000)}秒`);
            } else if (!isBangumi && streamData?.data?.timelength) {
                // 普通视频：使用 data.timelength  
                timelength = streamData.data.timelength;
            } else if (video[0]?.duration) {
                // Fallback: 使用视频流中的duration（秒）
                timelength = video[0].duration * 1000;
            } else if (audioData?.duration) {
                // 最后尝试使用音频duration
                timelength = audioData.duration * 1000;
            }
        }

        logger.debug(`[R插件][BILI下载] 时长信息: ${timelength > 0 ? Math.round(timelength / 1000) + '秒' : '未获取到'}${duration > 0 ? ' (来自参数)' : ''}`);

        // 番剧不使用文件大小限制和智能分辨率
        if (isBangumi) {
            smartResolution = false;
        }

        // 使用传入的文件大小限制
        const sizeLimit = fileSizeLimit; // MB

        // 如果无法获取时长，使用基于码率的fallback策略
        if (timelength === 0 && !isBangumi) {
            logger.warn(`[R插件][BILI下载] 无法获取视频时长，使用码率限制策略`);

            // 假设平均视频时长为5分钟（300秒），计算对应100MB的最大码率
            // 100MB = 100 * 1024 * 1024 * 8 bits = 838860800 bits
            // 300秒 -> 838860800 / 300 = 2796202 bps ≈ 2800 kbps (视频+音频总码率)
            const assumedDuration = 300; // 秒
            const maxTotalBandwidth = (sizeLimit * 1024 * 1024 * 8) / assumedDuration; // bps

            logger.info(`[R插件][BILI下载] 假设视频时长${assumedDuration}秒，计算最大总码率: ${Math.round(maxTotalBandwidth / 1024)}kbps`);

            // 尝试找到总码率不超过限制的最佳视频流
            for (const candidate of sortedVideos) {
                const videoBandwidth = candidate.bandwidth || 0;
                const audioBandwidth = audioData?.bandwidth || 0;
                const totalBandwidth = videoBandwidth + audioBandwidth;

                if (totalBandwidth <= maxTotalBandwidth) {
                    videoData = candidate;
                    const codecType = getCodecType(candidate.codecs);
                    logger.info(`[R插件][BILI下载] 选择视频流: ${candidate.height}p, 编码: ${codecType.toUpperCase()}(${candidate.codecs}), 总码率: ${Math.round(totalBandwidth / 1024)}kbps (预估≈${Math.round((totalBandwidth * assumedDuration) / (8 * 1024 * 1024))}MB)`);
                    break;
                } else {
                    logger.debug(`[R插件][BILI下载] 跳过高码率视频流: ${candidate.height}p, 总码率: ${Math.round(totalBandwidth / 1024)}kbps (预估超过100MB)`);
                }
            }

            // 如果所有流都超过码率限制，选择最后一个（码率最低的）
            if (!videoData) {
                videoData = sortedVideos[sortedVideos.length - 1];
                const totalBandwidth = (videoData.bandwidth || 0) + (audioData?.bandwidth || 0);
                const codecType = getCodecType(videoData.codecs);
                logger.warn(`[R插件][BILI下载] 所有视频流码率都较高，选择最小码率: ${videoData.height}p, 编码: ${codecType.toUpperCase()}, 总码率: ${Math.round(totalBandwidth / 1024)}kbps`);
            }
        } else {
            // 有时长信息，使用精确的文件大小估算
            // 智能分辨率：从最高画质开始遍历，找到不超过限制的最高画质
            if (smartResolution) {
                // 将高度(px)转换为BILI_RESOLUTION_LIST的value值用于比较
                const heightToResValue = (height) => {
                    if (height >= 4320) return 0;  // 8K
                    if (height >= 2160) return 3;  // 4K
                    if (height >= 1080) return 6;  // 1080P
                    if (height >= 720) return 8;   // 720P
                    if (height >= 480) return 9;   // 480P
                    return 10; // 360P
                };

                // 获取所有可用的分辨率，从高到低排序，并过滤掉低于最低分辨率的
                const allHeights = [...new Set(video.map(v => v.height))].sort((a, b) => b - a);
                const availableHeights = allHeights.filter(h => heightToResValue(h) <= minResolution);

                // 如果过滤后没有可用画质，使用所有画质但记录警告
                const heightsToTry = availableHeights.length > 0 ? availableHeights : allHeights;
                if (availableHeights.length === 0) {
                    logger.debug(`[R插件][BILI下载] 所有画质都低于最低分辨率设置，将尝试所有可用画质`);
                }

                const maxHeight = heightsToTry[0];

                // 从最高画质开始尝试
                for (const height of heightsToTry) {
                    logger.debug(`[R插件][BILI下载] 尝试${height}p分辨率`);

                    // 获取该分辨率的所有流并按编码优先级排序
                    const heightVideos = video.filter(v => v.height === height);
                    const sortedHeightVideos = heightVideos.sort((a, b) => {
                        const codecTypeA = getCodecType(a.codecs);
                        const codecTypeB = getCodecType(b.codecs);
                        const priorityA = codecPriority[codecTypeA];
                        const priorityB = codecPriority[codecTypeB];
                        if (priorityA !== priorityB) {
                            return priorityA - priorityB;
                        }
                        // 智能分辨率：同一编码下优先选择高码率（画质更好）
                        return b.bandwidth - a.bandwidth;
                    });

                    // 尝试找到符合大小的流（优先AV1）
                    for (const candidate of sortedHeightVideos) {
                        const estimatedSizeMB = estimateSize(candidate, audioData, timelength);
                        if (estimatedSizeMB <= sizeLimit) {
                            videoData = candidate;
                            const codecType = getCodecType(candidate.codecs);
                            logger.info(`[R插件][BILI下载] ✅ 智能分辨率选择: ${candidate.height}p, 编码: ${codecType.toUpperCase()}(${candidate.codecs}), 预估大小: ${Math.round(estimatedSizeMB)}MB`);
                            break;
                        }
                    }

                    if (videoData) break;
                }

                // 如果所有画质都超过限制，检查最低画质是否也超限
                if (!videoData) {
                    const lowestHeight = availableHeights[availableHeights.length - 1];
                    const lowestVideos = video.filter(v => v.height === lowestHeight);
                    const lowestVideo = lowestVideos.sort((a, b) => a.bandwidth - b.bandwidth)[0];
                    const estimatedSizeMB = estimateSize(lowestVideo, audioData, timelength);
                    const codecType = getCodecType(lowestVideo.codecs);

                    // 检查最低画质是否超过文件大小限制
                    if (estimatedSizeMB > sizeLimit) {
                        logger.warn(`[R插件][BILI下载] 最低画质${lowestVideo.height}p预估大小${Math.round(estimatedSizeMB)}MB仍超过限制${sizeLimit}MB，放弃解析`);
                        return {
                            videoUrl: null,
                            audioUrl: null,
                            skipReason: `视频最低画质(${lowestVideo.height}p)预估${Math.round(estimatedSizeMB)}MB超过限制${sizeLimit}MB，已跳过`
                        };
                    }

                    // 最低画质未超限，使用它
                    videoData = lowestVideo;
                    logger.warn(`[R插件][BILI下载] 所有画质都超过${sizeLimit}MB，选择最低: ${videoData.height}p, 编码: ${codecType.toUpperCase()}, 预估大小: ${Math.round(estimatedSizeMB)}MB`);
                }
            } else {
                // 非智能分辨率（包括番剧）
                if (isBangumi) {
                    // ===== 番剧特殊处理 =====
                    // 番剧不受文件大小限制，直接选择请求画质的最佳编码
                    // 但如果请求画质不可用，则选择可用的最高画质

                    // 1. 先尝试找到请求画质
                    let bangumiVideos = video.filter(v => v.height === targetHeight);

                    if (bangumiVideos.length === 0) {
                        // 2. 如果请求画质不可用，找最高可用画质
                        const maxHeight = Math.max(...video.map(v => v.height));
                        bangumiVideos = video.filter(v => v.height === maxHeight);
                        logger.warn(`[R插件][BILI下载] 番剧：请求画质${targetHeight}p不可用，使用最高画质${maxHeight}p`);
                    }

                    // 3. 按编码优先级排序（AV1>HEVC>AVC）
                    bangumiVideos.sort((a, b) => {
                        const codecTypeA = getCodecType(a.codecs);
                        const codecTypeB = getCodecType(b.codecs);
                        const priorityA = codecPriority[codecTypeA];
                        const priorityB = codecPriority[codecTypeB];

                        if (priorityA !== priorityB) {
                            return priorityA - priorityB;
                        }
                        return a.bandwidth - b.bandwidth; // 相同编码选低码率
                    });

                    videoData = bangumiVideos[0];
                    const estimatedSizeMB = estimateSize(videoData, audioData, timelength);
                    const codecType = getCodecType(videoData.codecs);
                    logger.info(`[R插件][BILI下载] 番剧选择最佳编码: ${videoData.height}p, 编码: ${codecType.toUpperCase()}(${videoData.codecs}), 预估大小: ${Math.round(estimatedSizeMB)}MB`);
                } else {
                    // 普通视频：使用请求的画质，按编码优先级和文件大小选择
                    for (const candidate of sortedVideos) {
                        const estimatedSizeMB = estimateSize(candidate, audioData, timelength);

                        if (estimatedSizeMB <= sizeLimit) {
                            videoData = candidate;
                            const codecType = getCodecType(candidate.codecs);
                            logger.info(`[R插件][BILI下载] 选择视频流: ${candidate.height}p, 编码: ${codecType.toUpperCase()}(${candidate.codecs}), 预估大小: ${Math.round(estimatedSizeMB)}MB`);
                            break;
                        } else {
                            logger.debug(`[R插件][BILI下载] 跳过超大视频流: ${candidate.height}p, 编码: ${candidate.codecs}, 预估大小: ${Math.round(estimatedSizeMB)}MB (超过${sizeLimit}MB限制)`);
                        }
                    }

                    // 如果所有流都超过大小，选择最小码率的
                    if (!videoData) {
                        videoData = sortedVideos[sortedVideos.length - 1];
                        const estimatedSizeMB = estimateSize(videoData, audioData, timelength);
                        const codecType = getCodecType(videoData.codecs);
                        logger.warn(`[R插件][BILI下载] 所有视频流都超过${sizeLimit}MB限制，选择最小码率: ${videoData.height}p, 编码: ${codecType.toUpperCase()}, 预估大小: ${Math.round(estimatedSizeMB)}MB`);
                    }
                }
            }
        }
    }

    if (!videoData) {
        logger.error(`[R插件][BILI下载] 获取视频数据失败，请检查画质参数是否正确`);
        return { videoUrl: null, audioUrl: null };
    }

    logger.debug(`[R插件][BILI下载] 请求画质: ${qualityText}, 实际获取画质: ${videoData.height}p，分辨率: ${videoData.width}x${videoData.height}, 编码: ${videoData.codecs}, 码率: ${Math.round(videoData.bandwidth / 1024)}kbps`);

    // 提取信息
    const { backupUrl: videoBackupUrl, baseUrl: videoBaseUrl } = videoData;
    const videoUrl = selectAndAvoidMCdnUrl(videoBaseUrl, videoBackupUrl, cdnMode);

    // 音频处理 - 选择对应画质的音频流
    const audioData = audio?.[0];
    let audioUrl = null;
    if (audioData != null && audioData !== undefined) {
        const { backupUrl: audioBackupUrl, baseUrl: audioBaseUrl } = audioData;
        audioUrl = selectAndAvoidMCdnUrl(audioBaseUrl, audioBackupUrl, cdnMode);
        logger.debug(`[R插件][BILI下载] 音频码率: ${Math.round(audioData.bandwidth / 1024)}kbps`);
    }

    return { videoUrl, audioUrl };
}

/**
 * 合并视频和音频
 * @param vFullFileName
 * @param aFullFileName
 * @param outputFileName
 * @param shouldDelete
 * @returns {Promise<{outputFileName}>}
 */
export async function mergeFileToMp4(vFullFileName, aFullFileName, outputFileName, shouldDelete = true) {
    // 判断当前环境
    let env;
    if (process.platform === "win32") {
        env = process.env
    } else if (process.platform === "linux") {
        env = {
            ...process.env,
            PATH: '/usr/local/bin:' + child_process.execSync('echo $PATH').toString(),
        };
    } else {
        logger.warn("[R插件][合并视频和音频] 检测到未知系统，可能是MacOS.");
    }
    const execFile = util.promisify(child_process.execFile);
    try {
        const cmd = 'ffmpeg';

        // 🔧 Linux 下添加 -movflags +faststart 确保 AV1 视频关键帧正确
        // 这不会重新编码，只是添加元数据标记
        const extraArgs = process.platform === 'linux' ? ['-movflags', '+faststart'] : [];

        const args = ['-y', '-i', vFullFileName, '-i', aFullFileName, '-c', 'copy', ...extraArgs, outputFileName];

        if (extraArgs.length > 0) {
            logger.debug(`[R插件][合并视频和音频] Linux环境，添加关键帧标记参数`);
        }

        await execFile(cmd, args, { env });

        if (shouldDelete) {
            await fs.promises.unlink(vFullFileName);
            await fs.promises.unlink(aFullFileName);
        }

        return { outputFileName };
    } catch (err) {
        logger.error(err);
    }
}

/**
 * 下载m4s文件，通过ffmpeg转换成mp3
 * @param m4sUrl
 * @returns {Promise<void>}
 */
export async function m4sToMp3(m4sUrl, path) {
    return axios
        .get(m4sUrl, {
            responseType: 'stream',
            headers: {
                ...BILI_HEADER
            },
        }).then(async res => {
            // 如果没有目录就创建一个
            await mkdirIfNotExists(path)
            // 补充保存文件名
            path += "/temp.m4s";
            if (fs.existsSync(path)) {
                fs.unlinkSync(path);
            }
            // 开始下载
            const fileStream = fs.createWriteStream(path);
            res.data.pipe(fileStream);
            // 下载完成
            return new Promise((resolve, reject) => {
                fileStream.on("finish", () => {
                    fileStream.close(() => {
                        const transformCmd = `ffmpeg -i ${path} ${path.replace(".m4s", ".mp3")} -y -loglevel quiet`;
                        child_process.execSync(transformCmd)
                        logger.mark("bili: mp3下载完成")
                        resolve(path);
                    });
                });
                fileStream.on("error", err => {
                    fs.unlink(path, () => {
                        reject(err);
                    });
                });
            });
        });
}

/**
 * 哔哩哔哩音乐下载
 * @param bvid BVID
 * @param cid  （选项）CID
 * @returns {Promise<any>}
 */
export async function getBiliAudio(bvid, cid) {
    // 转换cid
    if (!cid)
        cid = await fetchCID(bvid).catch((err) => logger.info(err))

    // 返回一个fetch的promise
    return (new Promise((resolve, reject) => {
        fetch(BILI_PLAY_STREAM.replace("{bvid}", bvid).replace("{cid}", cid), {
            headers: {
                ...BILI_HEADER,
            }
        })
            .then(res => res.json())
            .then(json => resolve(json.data.dash.audio[0].baseUrl));
    }))
}

export async function getBiliVideoWithSession(bvid, cid, SESSDATA, qn, smartResolution = false) {
    if (!cid) {
        cid = await fetchCID(bvid).catch((err) => logger.error(err))
    }

    // 计算对应的fnval和fourk参数
    const { fnval, fourk } = calculateFnval(qn, smartResolution);

    const apiUrl = BILI_PLAY_STREAM
        .replace("{bvid}", bvid)
        .replace("{cid}", cid)
        .replace("{qn}", qn)
        .replace("{fnval}", fnval)
        .replace("{fourk}", fourk);
    logger.debug(`[R插件][BILI请求审计] 请求URL: ${apiUrl}`);
    logger.debug(`[R插件][BILI请求审计] 计算的fnval: ${fnval} (${fnval.toString(2)}), fourk: ${fourk}`);

    // 从cookie字符串中提取SESSDATA值
    const sessDataValue = extractSessData(SESSDATA);

    // 确定发送哪种Cookie格式
    const cookieHeader = SESSDATA.includes('SESSDATA=') ? SESSDATA : `SESSDATA=${sessDataValue}`;

    return (new Promise((resolve, reject) => {
        fetch(apiUrl, {
            headers: {
                ...BILI_HEADER,
                Cookie: cookieHeader
            }
        })
            .then(res => res.json())
            .then(json => {
                if (json.code !== 0) {
                    logger.error(`[R插件][BILI请求审计] 请求失败: ${json.message}`);
                    reject(new Error(json.message));
                } else if (json.data?.dash?.video) {
                    // 正常的dash格式
                    const qualityInfo = json.data.dash.video
                        .sort((a, b) => b.height - a.height)  // 按分辨率从高到低排序
                        .map(v => `${v.height}p(${v.codecs}): ${Math.round(v.bandwidth / 1024)}kbps`)
                        .join(', ');
                    logger.debug(`[R插件][BILI请求审计] 请求成功，可用画质列表: ${qualityInfo}`);
                    resolve(json.data.dash);
                } else if (json.data?.durl) {
                    // 试看视频返回durl格式
                    const isPreview = json.data.is_preview === 1;
                    resolve({
                        _type: 'durl',
                        _isPreview: isPreview,
                        durl: json.data.durl,
                        quality: json.data.quality,
                        supportFormats: json.data.support_formats || [],
                        acceptQuality: json.data.accept_quality || [],
                        timelength: json.data.durl[0]?.length || 0
                    });
                } else {
                    // 既没有dash也没有durl
                    logger.error(`[R插件][BILI请求审计] 视频无可用数据，可能需要大会员或视频不可用`);
                    reject(new Error('视频无法解析：可能需要大会员或视频不可用'));
                }
            })
            .catch(err => {
                logger.error(`[R插件][BILI请求审计] 请求异常: ${err.message}`);
                reject(err);
            });
    }))
}

/**
 * 获取番剧视频流（使用PGC专用API）
 * @param epId    EP ID
 * @param cid     CID
 * @param SESSDATA 登录凭证
 * @param qn      画质参数
 * @returns {Promise<{type: 'dash'|'durl', data: any}>} 返回格式类型和数据
 */
export async function getBangumiBiliVideoWithSession(epId, cid, SESSDATA, qn, smartResolution = false) {
    // 计算对应的fnval和fourk参数
    const { fnval, fourk } = calculateFnval(qn, smartResolution);

    const apiUrl = BILI_BANGUMI_STREAM
        .replace("{ep_id}", epId)
        .replace("{cid}", cid)
        .replace("{qn}", qn)
        .replace("{fnval}", fnval)
        .replace("{fourk}", fourk);

    // 从cookie字符串中提取SESSDATA值
    const sessDataValue = extractSessData(SESSDATA);

    // 调试：检查SESSDATA是否正确传递
    const hasValidSessData = sessDataValue && sessDataValue.length > 10;
    logger.info(`[R插件][番剧请求审计] 请求URL: ${apiUrl}`);
    logger.info(`[R插件][番剧请求审计] SESSDATA状态: ${hasValidSessData ? '已配置(' + sessDataValue.substring(0, 8) + '...)' : '未配置或无效'}`);
    logger.debug(`[R插件][番剧] 请求画质QN: ${qn}`);

    // 确定发送哪种Cookie格式
    // 如果传入的是完整cookie字符串（包含其他字段），就发送完整cookie
    // 否则只发送SESSDATA
    const cookieHeader = SESSDATA.includes('SESSDATA=') ? SESSDATA : `SESSDATA=${sessDataValue}`;
    logger.debug(`[R插件][番剧请求审计] Cookie格式: ${SESSDATA.includes('SESSDATA=') ? '完整cookie' : '仅SESSDATA'}`);

    return (new Promise((resolve, reject) => {
        fetch(apiUrl, {
            headers: {
                ...BILI_HEADER,
                Cookie: cookieHeader
            }
        })
            .then(res => res.json())
            .then(json => {
                if (json.code !== 0) {
                    logger.error(`[R插件][番剧请求审计] 请求失败: code=${json.code}, message=${json.message}`);
                    reject(new Error(`番剧API错误: ${json.message} (code: ${json.code})`));
                    return;
                }

                const result = json.result;
                if (!result) {
                    logger.error(`[R插件][番剧请求审计] 返回数据为空`);
                    reject(new Error(`番剧API返回数据为空`));
                    return;
                }

                // 调试：输出番剧API返回的关键信息
                logger.info(`[R插件][番剧API调试] timelength: ${result.timelength || '无'}ms`);
                logger.info(`[R插件][番剧API调试] quality: ${result.quality || '无'}`);
                logger.info(`[R插件][番剧API调试] format: ${result.format || '无'}`);
                logger.info(`[R插件][番剧API调试] type: ${result.type || '无'}`);

                // 检查返回格式：dash 或 durl
                if (result.dash) {
                    // DASH 格式（分离的音视频流）
                    const qualityInfo = result.dash.video
                        .sort((a, b) => b.height - a.height)
                        .map(v => `${v.height}p(${v.codecs}): ${Math.round(v.bandwidth / 1024)}kbps`)
                        .join(', ');
                    logger.info(`[R插件][番剧请求审计] DASH格式，可用画质列表: ${qualityInfo}`);
                    // 返回dash数据和完整的result对象（用于提取timelength等）
                    resolve({ type: 'dash', data: result.dash, result: result });
                } else if (result.durl || result.durls) {
                    // DURL 格式（完整视频文件）
                    const requestedQn = qn;
                    const currentQuality = result.quality;
                    const supportFormats = result.support_formats || [];
                    const isPreview = result.is_preview === 1;
                    const errorCode = result.error_code;

                    // 记录详细信息
                    logger.info(`[R插件][番剧请求审计] DURL格式 - ${isPreview ? '⚠️预览模式' : '完整视频'}`);
                    logger.info(`[R插件][番剧请求审计] 请求画质QN: ${requestedQn}, API返回画质QN: ${currentQuality}`);
                    if (errorCode) {
                        logger.warn(`[R插件][番剧请求审计] API错误码: ${errorCode}`);
                    }

                    // 选择匹配请求画质的durl
                    let targetDurl = result.durl;
                    let actualQuality = currentQuality;

                    if (result.durls && result.durls.length > 0) {
                        // 记录所有可用画质
                        const availableQualities = result.durls.map(d => d.quality).sort((a, b) => b - a);
                        logger.info(`[R插件][番剧请求审计] durls中可用画质QN: [${availableQualities.join(', ')}]`);

                        // 尝试匹配请求的画质
                        let matchedDurl = result.durls.find(d => d.quality === requestedQn);

                        if (matchedDurl) {
                            // 找到匹配的画质
                            targetDurl = matchedDurl.durl;
                            actualQuality = matchedDurl.quality;
                            logger.info(`[R插件][番剧请求审计] ✅ 使用匹配的画质: ${actualQuality}`);
                        } else {
                            // 未找到匹配的画质，使用最高可用画质
                            const sorted = result.durls.sort((a, b) => b.quality - a.quality);
                            targetDurl = sorted[0].durl;
                            actualQuality = sorted[0].quality;

                            const requestedFormat = supportFormats.find(f => f.quality === requestedQn);
                            const actualFormat = supportFormats.find(f => f.quality === actualQuality);

                            logger.warn(`[R插件][番剧请求审计] ⚠️ 请求的画质 ${requestedQn}(${requestedFormat?.description || '未知'}) 不可用`);
                            logger.warn(`[R插件][番剧请求审计] 降级到最高可用画质: ${actualQuality}(${actualFormat?.description || '未知'})`);

                            if (requestedFormat?.need_vip) {
                                logger.error(`[R插件][番剧请求审计] ❌ 该画质需要大会员！请检查SESSDATA是否为大会员账号`);
                            }
                        }
                    } else if (result.durl) {
                        logger.info(`[R插件][番剧请求审计] 使用单一durl，画质: ${currentQuality}`);
                    }

                    resolve({
                        type: 'durl',
                        data: {
                            durl: targetDurl,
                            quality: actualQuality,
                            supportFormats: supportFormats,
                            isPreview: isPreview,
                            errorCode: errorCode
                        }
                    });
                } else {
                    logger.error(`[R插件][番剧请求审计] 未知的返回格式: ${JSON.stringify(result).substring(0, 500)}`);
                    reject(new Error(`番剧API返回未知格式`));
                }
            })
            .catch(err => {
                logger.error(`[R插件][番剧请求审计] 请求异常: ${err.message}`);
                reject(err);
            });
    }))
}

/**
 * bvid转换成cid
 * @param bvid
 * @returns {Promise<*>}
 */
export const fetchCID = async (bvid) => {
    //logger.info('Data.js Calling fetchCID:' + URL_BVID_TO_CID.replace("{bvid}", bvid))
    const res = await fetch(BILI_BVID_TO_CID.replace("{bvid}", bvid));
    const json = await res.json();
    const cid = json.data[0].cid;
    return cid;
}

/**
 * 获取指定分P的CID
 * @param bvid BVID
 * @param pNumber 分P号（1-indexed）
 * @returns {Promise<string|null>} CID或null
 */
export async function getPageCid(bvid, pNumber) {
    try {
        const resp = await fetch(`${BILI_VIDEO_INFO}?bvid=${bvid}`);
        const json = await resp.json();
        const pages = json.data?.pages;
        if (pages && pages.length >= pNumber && pNumber > 0) {
            const targetPage = pages[pNumber - 1];
            logger.debug(`[R插件][BILI] 分P${pNumber} CID: ${targetPage.cid}`);
            return targetPage.cid;
        }
        logger.warn(`[R插件][BILI下载] 找不到P${pNumber}，使用P1`);
        return pages?.[0]?.cid || null;
    } catch (err) {
        logger.error(`[R插件][BILI下载] 获取分P CID失败: ${err.message}`);
        return null;
    }
}

/**
 * 获取视频信息
 * @param url
 * @returns {Promise<{duration: *, owner: *, bvid: *, stat: *, pages: *, dynamic: *, pic: *, title: *, aid: *, desc: *, cid: *}>}
 */
export async function getVideoInfo(url) {
    // const baseVideoInfo = "http://api.bilibili.com/x/web-interface/view";
    const videoId = /video\/[^\?\/ ]+/.exec(url)[0].split("/")[1];
    // 如果匹配到的是AV号特殊处理
    let finalUrl = `${BILI_VIDEO_INFO}?`;
    if (videoId.toLowerCase().startsWith('av')) {
        finalUrl += `aid=${videoId.slice(2)}`;
    } else {
        finalUrl += `bvid=${videoId}`;
    }
    logger.debug(finalUrl);
    // 获取视频信息，然后发送
    return fetch(finalUrl)
        .then(async resp => {
            const respJson = await resp.json();
            const respData = respJson.data;
            return {
                title: respData.title,
                pic: respData.pic,
                desc: respData.desc,
                duration: respData.duration,
                dynamic: respJson.data.dynamic,
                stat: respData.stat,
                bvid: respData.bvid,
                aid: respData.aid,
                cid: respData.pages?.[0].cid,
                owner: respData.owner,
                pages: respData?.pages,
            };
        });
}

/**
 * 获取番剧视频信息
 * @param epId EP ID
 * @returns {Promise<{bvid: string, cid: string} | null>}
 */
export async function getBangumiVideoInfo(epId) {
    try {
        const resp = await fetch(BILI_EP_INFO.replace("{}", epId), {
            headers: BILI_HEADER
        });
        const json = await resp.json();
        if (json.code !== 0) {
            logger.error(`[R插件][番剧信息] 获取番剧信息失败: ${json.message}`);
            return null;
        }
        const result = json.result;
        // 从episodes中找到对应的EP信息
        let targetEp = null;
        for (const section of [result.episodes, ...(result.section || []).map(s => s.episodes)]) {
            if (!section) continue;
            targetEp = section.find(ep => ep.id.toString() === epId || ep.ep_id?.toString() === epId);
            if (targetEp) break;
        }
        if (!targetEp) {
            // 尝试从main_section获取
            if (result.main_section?.episodes) {
                targetEp = result.main_section.episodes.find(ep => ep.id.toString() === epId || ep.ep_id?.toString() === epId);
            }
        }
        if (!targetEp) {
            // 如果还是找不到，使用第一个episode
            targetEp = result.episodes?.[0];
            logger.info(`[R插件][番剧信息] 未找到EP ${epId}，使用第一集: ${targetEp?.bvid}`);
        }
        if (!targetEp) {
            logger.error(`[R插件][番剧信息] 无法获取番剧EP信息`);
            return null;
        }
        return {
            bvid: targetEp.bvid,
            cid: targetEp.cid?.toString() || ""
        };
    } catch (err) {
        logger.error(`[R插件][番剧信息] 获取番剧信息异常: ${err.message}`);
        return null;
    }
}

/**
 * 获取动态
 * @param dynamicId 动态ID
 * @param SESSDATA 登录凭证
 * @returns {Promise<{title: string, paragraphs: Array}>} 返回标题和段落数组
 */
export async function getDynamic(dynamicId, SESSDATA) {
    const dynamicApi = BILI_DYNAMIC.replace("{}", dynamicId);
    return axios.get(dynamicApi, {
        headers: {
            ...BILI_HEADER,
            Cookie: `SESSDATA=${SESSDATA}`
        },
    }).then(resp => {
        const item = resp.data?.data?.item;
        let title = '';
        let paragraphs = []; // 按原始顺序存储所有段落

        // 遍历所有模块
        for (const module of item.modules) {
            // MODULE_TYPE_TITLE: 标题
            if (module.module_type === 'MODULE_TYPE_TITLE' && module.module_title) {
                title = decodeHtmlEntities(module.module_title.text || '');
            }
            // MODULE_TYPE_TOPIC: 话题
            else if (module.module_type === 'MODULE_TYPE_TOPIC' && module.module_topic) {
                paragraphs.push({
                    type: 'topic',
                    content: `🏷️ 话题：${decodeHtmlEntities(module.module_topic.name)}`
                });
            }
            // MODULE_TYPE_TOP: 顶部大图/banner
            else if (module.module_type === 'MODULE_TYPE_TOP' && module.module_top?.display) {
                const display = module.module_top.display;
                // 处理顶部图片
                if (display.type === 1 && display.album?.pics) {
                    for (const pic of display.album.pics) {
                        paragraphs.push({
                            type: 'image',
                            url: pic.url
                        });
                    }
                }
            }

            // 提取内容模块
            if (module.module_type === 'MODULE_TYPE_CONTENT') {
                const paraList = module.module_content?.paragraphs || [];
                for (const para of paraList) {
                    // para_type=1: 文本段落
                    if (para.para_type === 1 && para.text) {
                        const textContent = extractTextFromNodes(para.text.nodes);
                        if (textContent && textContent.trim()) {
                            paragraphs.push({
                                type: 'text',
                                content: textContent
                            });
                        }
                    }
                    // para_type=2: 图片段落
                    else if (para.para_type === 2 && para.pic) {
                        for (const pic of para.pic.pics || []) {
                            if (pic.url) {
                                paragraphs.push({
                                    type: 'image',
                                    url: pic.url
                                });
                            }
                        }
                    }
                    // para_type=3: 分割线
                    else if (para.para_type === 3) {
                        paragraphs.push({
                            type: 'divider',
                            content: '---'
                        });
                    }
                    // para_type=4: 块引用
                    else if (para.para_type === 4 && para.text) {
                        const textContent = extractTextFromNodes(para.text.nodes);
                        if (textContent && textContent.trim()) {
                            paragraphs.push({
                                type: 'quote',
                                content: `「${textContent}」`
                            });
                        }
                    }
                    // para_type=5: 列表
                    else if (para.para_type === 5 && para.list) {
                        for (const item of para.list.items || []) {
                            const listText = extractTextFromNodes(item.nodes);
                            if (listText && listText.trim()) {
                                paragraphs.push({
                                    type: 'list',
                                    content: `• ${listText}`
                                });
                            }
                        }
                    }
                    // para_type=6: 链接卡片
                    else if (para.para_type === 6 && para.link_card) {
                        const card = para.link_card.card;
                        if (card) {
                            // 提取卡片的基本信息和URL
                            let cardText = '';
                            let cardUrl = '';

                            if (card.type === 'LINK_CARD_TYPE_UGC' && card.ugc) {
                                cardText = card.ugc.title || '视频链接';
                                cardUrl = card.ugc.jump_url || '';
                            } else if (card.type === 'LINK_CARD_TYPE_WEB' && card.common) {
                                cardText = card.common.title || '网页链接';
                                cardUrl = card.common.jump_url || '';
                            } else if (card.type === 'LINK_CARD_TYPE_COMMON' && card.common) {
                                cardText = card.common.title || '链接';
                                cardUrl = card.common.jump_url || '';
                            } else if (card.type === 'LINK_CARD_TYPE_VOTE' && card.vote) {
                                cardText = `投票：${card.vote.title || '投票'}`;
                                cardUrl = ''; // 投票卡片没有jump_url？
                            } else {
                                cardText = '链接卡片';
                                cardUrl = '';
                            }
                            // 格式化输出:如果有URL则显示 否则只显示文本
                            let finalText = '';
                            if (cardUrl) {
                                finalText = `🔗 ${cardText}(${cardUrl})`;
                            } else {
                                finalText = `📊 ${cardText}`;
                            }
                            paragraphs.push({
                                type: 'link_card',
                                content: finalText
                            });
                        }
                    }
                    // para_type=7: 代码块
                    else if (para.para_type === 7 && para.code) {
                        const codeText = para.code.code_content || '';
                        if (codeText) {
                            paragraphs.push({
                                type: 'code',
                                content: `\`\`\`\n${codeText}\n\`\`\``
                            });
                        }
                    }
                }
            }
        }
        return {
            title,
            paragraphs
        };
    });
}

/**
 * 解码HTML实体
 * @param {string} text - 含有HTML实体的文本
 * @returns {string} 解码后的文本
 */
function decodeHtmlEntities(text) {
    if (!text) return '';

    // 常见HTML实体映射
    const entities = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&#34;': '"',
        '&#39;': "'",
        '&apos;': "'",
        '&nbsp;': ' ',
        '&#x27;': "'",
        '&#x2F;': '/',
    };

    // 替换命名实体
    let decoded = text;
    for (const [entity, char] of Object.entries(entities)) {
        decoded = decoded.replace(new RegExp(entity, 'g'), char);
    }
    // 处理数字实体 &#数字;
    decoded = decoded.replace(/&#(\d+);/g, (match, dec) => {
        return String.fromCharCode(dec);
    });
    // 处理十六进制实体 &#x数字;
    decoded = decoded.replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
        return String.fromCharCode(parseInt(hex, 16));
    });
    return decoded;
}

/**
 * 从文本节点数组中提取文本内容
 * @param nodes 文本节点数组
 * @returns {string} 提取的文本
 */
function extractTextFromNodes(nodes) {
    if (!Array.isArray(nodes)) {
        return '';
    }

    let text = '';
    for (const node of nodes) {
        // 处理普通文本节点
        if (node.type === 'TEXT_NODE_TYPE_WORD' && node.word) {
            let words = node.word.words || '';
            // 应用文本样式
            if (node.word.style) {
                // 删除线：在每个字符后添加U+0336组合字符
                if (node.word.style.strikethrough) {
                    words = Array.from(words).map(char => char + '\u0336').join('');
                }
            }
            text += words;
        }
        // 处理富文本节点
        else if (node.type === 'TEXT_NODE_TYPE_RICH' && node.rich) {
            let richText = '';
            // 特殊处理网页链接类型
            if (node.rich.type === 'RICH_TEXT_NODE_TYPE_WEB') {
                const linkText = node.rich.text || '网页链接';
                const jumpUrl = node.rich.jump_url || '';
                if (jumpUrl) {
                    richText = `🔗 ${linkText}(${jumpUrl})`;
                } else {
                    richText = linkText;
                }
            }
            // 处理话题标签类型
            else if (node.rich.type === 'RICH_TEXT_NODE_TYPE_TOPIC') {
                // 保留原始的 #话题# 格式
                richText = node.rich.text || node.rich.orig_text || '';
            } else {
                // 其他富文本类型使用 text 字段
                richText = node.rich.text || node.rich.orig_text || '';
            }
            // 应用富文本样式（如删除线）
            if (node.rich.style && node.rich.style.strikethrough) {
                richText = Array.from(richText).map(char => char + '\u0336').join('');
            }
            text += richText;
        }
        // 处理公式节点
        else if (node.type === 'TEXT_NODE_TYPE_FORMULA' && node.formula) {
            text += node.formula.latex_content || '';
        }
    }
    // 解码HTML实体并返回
    return decodeHtmlEntities(text);
}

/**
 * 扫码
 * @param qrcodeSavePath      【必须】QR保存位置
 * @param detectTime          【可选】检测时间（默认10s检测一次）
 * @param hook                【可选】钩子函数，目前只用来人机交互
 * @returns {Promise<{
 *             SESSDATA,
 *             refresh_token
 *         }>}
 */
export async function getScanCodeData(qrcodeSavePath = 'qrcode.png', detectTime = 10, hook = () => {
}) {
    try {
        const resp = await axios.get(BILI_SCAN_CODE_GENERATE, { ...BILI_HEADER });
        // 保存扫码的地址、扫码登录秘钥
        const { url: scanUrl, qrcode_key } = resp.data.data;
        await qrcode.toFile(qrcodeSavePath, scanUrl);

        let code = 1;

        // 设置最大尝试次数
        let attemptCount = 0;
        const maxAttempts = 3;

        let loginResp;
        // 钩子函数，目前用于发送二维码给用户
        hook();
        // 检测扫码情况默认 10s 检测一次，并且尝试3次，没扫就拜拜
        while (code !== 0 && attemptCount < maxAttempts) {
            loginResp = await axios.get(BILI_SCAN_CODE_DETECT.replace("{}", qrcode_key), { ...BILI_HEADER });
            code = loginResp.data.data.code;
            await new Promise(resolve => setTimeout(resolve, detectTime * 1000)); // Wait for detectTime seconds
        }
        // 获取刷新令牌
        const { refresh_token } = loginResp.data.data;

        // 获取cookie
        const cookies = loginResp.headers['set-cookie'];
        const SESSDATA = cookies
            .map(cookie => cookie.split(';').find(item => item.trim().startsWith('SESSDATA=')))
            .find(item => item !== undefined)
            ?.split('=')[1];

        return {
            SESSDATA,
            refresh_token
        };
    } catch (err) {
        logger.error(err);
        // 可能需要处理错误或返回一个默认值
        return {
            SESSDATA: '',
            refresh_token: ''
        };
    }
}

/**
 * 过滤简介中的一些链接
 * @param link
 * @returns {Promise<string>}
 */
export async function filterBiliDescLink(link) {
    // YouTube链接
    const regex = /(?:https?:\/\/)?(?:www\.|music\.)?youtube\.com\/[A-Za-z\d._?%&+\-=\/#]*/g;
    if (regex.test(link)) {
        // 使用replace方法过滤掉匹配的链接
        return link.replace(regex, '').replace(/\n/g, '').trim();
    }
    return link;
}

/**
 * 动态规避哔哩哔哩cdn中的mcdn
 * @param baseUrl
 * @param backupUrls
 * @param cdnMode CDN模式：0=自动选择, 1=使用原始CDN（不切换）, 2=强制镜像站
 * @returns {string}
 */
function selectAndAvoidMCdnUrl(baseUrl, backupUrls, cdnMode = 0) {
    // 模式1：直接使用API返回的原始CDN，不做任何切换
    if (cdnMode === 1) {
        logger.info(`[R插件][CDN选择] 模式1: 使用原始CDN: ${new URL(baseUrl).hostname}`);
        return baseUrl;
    }

    // 模式2：强制切换到镜像站
    if (cdnMode === 2) {
        const mirrorUrl = replaceP2PUrl(baseUrl);
        if (mirrorUrl !== baseUrl) {
            logger.info(`[R插件][CDN选择] 模式2: 强制切换到镜像站`);
            return mirrorUrl;
        }
        // 如果无法替换，从备用URL中找镜像站
        if (backupUrls && backupUrls.length > 0) {
            for (const url of backupUrls) {
                const mirrorBackup = replaceP2PUrl(url);
                if (mirrorBackup !== url) {
                    logger.info(`[R插件][CDN选择] 模式2: 使用备用镜像站`);
                    return mirrorBackup;
                }
            }
        }
        logger.info(`[R插件][CDN选择] 模式2: 无法找到镜像站，使用原始CDN: ${new URL(baseUrl).hostname}`);
        return baseUrl;
    }

    // 模式0（默认）：自动选择，智能避开慢速CDN
    // mcdn 慢速节点的特征（需要避免）
    const slowCdnPatterns = [
        '.mcdn.bilivideo.cn',
        'mountaintoys.cn',
        '.szbdyd.com'
    ];

    // 快速 CDN 的特征（优先选择）
    const fastCdnPatterns = [
        /^cn-[a-z]+-[a-z]+-\d+-\d+\.bilivideo\.com$/,  // 如 cn-jsnt-ct-01-07.bilivideo.com
        /upos-sz-mirror.*\.bilivideo\.com$/,
        /upos-hz-mirror.*\.bilivideo\.com$/
    ];

    // 检查是否是慢速CDN
    const isSlowCdn = (url) => {
        try {
            const hostname = new URL(url).hostname;
            return slowCdnPatterns.some(pattern => hostname.includes(pattern));
        } catch {
            return false;
        }
    };

    // 检查是否是快速CDN
    const isFastCdn = (url) => {
        try {
            const hostname = new URL(url).hostname;
            return fastCdnPatterns.some(pattern => pattern.test ? pattern.test(hostname) : hostname.includes(pattern));
        } catch {
            return false;
        }
    };

    // 如果 baseUrl 是快速CDN，直接返回
    if (isFastCdn(baseUrl)) {
        logger.info(`[R插件][CDN选择] 使用快速CDN: ${new URL(baseUrl).hostname}`);
        return baseUrl;
    }

    // 如果 baseUrl 不是慢速CDN，也可以接受
    if (!isSlowCdn(baseUrl)) {
        logger.info(`[R插件][CDN选择] 使用默认CDN: ${new URL(baseUrl).hostname}`);
        return baseUrl;
    }

    // baseUrl 是慢速CDN，尝试从 backupUrls 中找快速CDN
    if (backupUrls && backupUrls.length > 0) {
        // 优先找快速CDN
        const fastUrl = backupUrls.find(url => isFastCdn(url));
        if (fastUrl) {
            logger.info(`[R插件][CDN选择] 切换到快速CDN: ${new URL(fastUrl).hostname}`);
            return fastUrl;
        }

        // 找不到快速CDN，找任何非慢速CDN
        const goodUrl = backupUrls.find(url => !isSlowCdn(url));
        if (goodUrl) {
            logger.info(`[R插件][CDN选择] 避开mcdn，使用: ${new URL(goodUrl).hostname}`);
            return goodUrl;
        }
    }

    // 所有URL都是慢速CDN，尝试替换
    logger.info("[R插件][CDN选择] 所有URL都是慢速CDN，尝试替换为源站");
    return replaceP2PUrl(baseUrl) || baseUrl;
}

/**
 * 动态替换哔哩哔哩 CDN
 * @param url
 * @param cdnSelect
 * @returns {*|string}
 */
function replaceP2PUrl(url) {
    try {
        const urlObj = new URL(url);
        const hostName = urlObj.hostname;
        if (urlObj.hostname.match(/upos-sz-mirror08[ch]\.bilivideo\.com/) || urlObj.hostname.match(/upos-hz-mirrorakam\.akamaized\.net/)) {
            urlObj.host = 'upos-sz-mirrorhwo1.bilivideo.com'
            urlObj.port = 443;
            logger.info(`更换视频源: ${hostName} -> ${urlObj.host}`);
            return urlObj.toString();
        } else if (urlObj.hostname.match(/upos-sz-estgoss\.bilivideo\.com/) || urlObj.hostname.match(/upos-sz-mirrorali(ov|b)?\.bilivideo\.com/)) {
            urlObj.host = 'upos-sz-mirroralio1.bilivideo.com'
            urlObj.port = 443;
            logger.info(`更换视频源: ${hostName} -> ${urlObj.host}`);
            return urlObj.toString();
        } else if (urlObj.hostname.endsWith(".mcdn.bilivideo.cn") || urlObj.hostname.match(/cn(-[a-z]+){2}(-\d{2}){2}\.bilivideo\.com/)) {
            urlObj.host = 'upos-sz-mirrorcoso1.bilivideo.com';
            urlObj.port = 443;
            logger.info(`更换视频源: ${hostName} -> ${urlObj.host}`);
            return urlObj.toString();
        } else if (urlObj.hostname.endsWith(".szbdyd.com")) {
            urlObj.host = urlObj.searchParams.get('xy_usource');
            urlObj.port = 443;
            logger.info(`更换视频源: ${hostName} -> ${urlObj.host}`);
            return urlObj.toString();
        }
        return url;
    } catch (e) {
        return url;
    }
}

/**
 * 拼接分辨率，例如："720P 高清, 480P 清晰, 360P 流畅"
 * @param selectedValue
 * @returns {*}
 */
export function getResolutionLabels(selectedValue) {
    // 过滤出 value 大于等于 selectedValue 的所有对象
    const filteredResolutions = BILI_RESOLUTION_LIST.filter(resolution => resolution.value >= selectedValue);

    // 将这些对象的 label 拼接成一个字符串
    return filteredResolutions.map(resolution => resolution.label).join(', ');
}
