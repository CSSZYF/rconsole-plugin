import schedule from 'node-schedule';
import { REDIS_YUNZAI_ISOVERSEA, REDIS_YUNZAI_WHITELIST } from "../constants/constant.js";
import { REDIS_YUNZAI_GROUP_RESOLVE_PREFIX, RESOLVE_CONTROLLER_NAME_ENUM } from "../constants/resolve.js";
import config from "../model/config.js";
import { deleteFolderRecursive, readCurrentDir } from "../utils/file.js";
import { redisExistAndGetKey, redisGetKey, redisSetKey } from "../utils/redis-util.js";

// 自动清理定时
const autotime = config.getConfig("tools").autoclearTrashtime;
// 视频保存路径
const defaultPath = config.getConfig("tools").defaultPath;

export class switchers extends plugin {
    constructor() {
        super({
            name: "R插件开关类",
            dsc: "内含一些和Redis相关的开关类",
            priority: 300,
            rule: [
                {
                    reg: "^#设置海外解析$",
                    fnc: "setOversea",
                    permission: "master",
                },
                {
                    reg: "^清理垃圾$",
                    fnc: "clearTrash",
                    permission: "master",
                },
                {
                    reg: "^#设置R信任用户(.*)",
                    fnc: "setWhiteList",
                    permission: "master",
                },
                {
                    reg: "^#R信任用户$",
                    fnc: "getWhiteList",
                    permission: "master",
                },
                {
                    reg: "^#查询R信任用户(.*)",
                    fnc: "searchWhiteList",
                    permission: "master",
                },
                {
                    reg: "^#删除R信任用户(.*)",
                    fnc: "deleteWhiteList",
                    permission: "master",
                },
                {
                    reg: "^#(R解析状态|查询R解析)$",
                    fnc: "getGroupResolveStatus",
                    permission: "master",
                },
                {
                    reg: "^#开启解析(\\s+.+)?",
                    fnc: "enableResolve",
                    permission: "master",
                },
                {
                    reg: "^#关闭解析(\\s+.+)?",
                    fnc: "disableResolve",
                    permission: "master",
                },
                {
                    reg: "^解析$",  // 临时解析功能
                    fnc: "tempResolve",
                }
            ]
        });
    }

    /**
     * 设置海外模式
     * @param e
     * @returns {Promise<boolean>}
     */
    async setOversea(e) {
        try {
            // 查看当前设置
            let os = (await redisGetKey(REDIS_YUNZAI_ISOVERSEA))?.os;
            // 如果是第一次
            if (os === undefined) {
                await redisSetKey(REDIS_YUNZAI_ISOVERSEA, { os: false });
                os = false;
            }
            // 设置
            os = ~os;
            await redisSetKey(REDIS_YUNZAI_ISOVERSEA, { os });
            e.reply(`当前服务器：${os ? '海外服务器' : '国内服务器'}`);
            return true;
        } catch (err) {
            e.reply(`设置海外模式时发生错误: ${err.message}`);
            return false;
        }
    }

    /**
     * 手动清理垃圾
     * @param e
     * @returns {Promise<void>}
     */
    async clearTrash(e) {
        try {
            const { dataClearFileLen, rTempFileLen, rTempFolderLen } = await autoclearTrash();
            e.reply(`手动清理垃圾完成:\n` +
                `- 清理了${dataClearFileLen}个垃圾文件\n` +
                `- 清理了${rTempFolderLen}个空文件夹\n` +
                `- 清理了${rTempFileLen}个群临时文件`);
        } catch (err) {
            e.reply(`手动清理垃圾时发生错误: ${err.message}`);
        }
    }

    /**
     * 设置解析信任用户
     * @param e
     * @returns {Promise<void>}
     */
    async setWhiteList(e) {
        try {
            let trustUserId = e?.reply_id !== undefined ? (await e.getReply()).user_id : e.msg.replace("#设置R信任用户", "").trim();
            trustUserId = trustUserId.toString();
            // 用户ID检测
            if (!trustUserId) {
                e.reply("无效的R信任用户");
                return;
            }
            let whiteList = await redisExistAndGetKey(REDIS_YUNZAI_WHITELIST) || [];
            // 重复检测
            if (whiteList.includes(trustUserId)) {
                e.reply("R信任用户已存在，无须添加!");
                return;
            }
            whiteList.push(trustUserId);
            // 放置到Redis里
            await redisSetKey(REDIS_YUNZAI_WHITELIST, whiteList);
            e.reply(`成功添加R信任用户：${trustUserId}`);
        } catch (err) {
            e.reply(`设置R信任用户时发生错误: ${err.message}`);
        }
    }

    /**
     * 获取信任用户名单
     * @param e
     * @returns {Promise<void>}
     */
    async getWhiteList(e) {
        try {
            let whiteList = await redisExistAndGetKey(REDIS_YUNZAI_WHITELIST) || [];
            const message = `R信任用户列表：\n${whiteList.join(",\n")}`;
            if (this.e.isGroup) {
                await Bot.pickUser(this.e.user_id).sendMsg(await this.e.runtime.common.makeForwardMsg(this.e, message));
                await this.reply('R插件的信任用户名单已发送至您的私信了~');
            } else {
                await e.reply(await makeForwardMsg(this.e, message));
            }
        } catch (err) {
            e.reply(`获取R信任用户时发生错误: ${err.message}`);
        }
    }

    /**
     * 查询某个用户是否是信任用户
     * @param e
     * @returns {Promise<void>}
     */
    async searchWhiteList(e) {
        try {
            let trustUserId = e?.reply_id !== undefined ? (await e.getReply()).user_id : e.msg.replace("#查询R信任用户", "").trim();
            let whiteList = await redisExistAndGetKey(REDIS_YUNZAI_WHITELIST) || [];
            const isInWhiteList = whiteList.includes(trustUserId);
            e.reply(isInWhiteList ? `✅ ${trustUserId}已经是R插件的信任用户哦~` : `⚠️ ${trustUserId}不是R插件的信任用户哦~`);
        } catch (err) {
            e.reply(`查询R信任用户时发生错误: ${err.message}`);
        }
    }

    /**
     * 删除信任用户
     * @param e
     * @returns {Promise<void>}
     */
    async deleteWhiteList(e) {
        try {
            let trustUserId = e?.reply_id !== undefined ? (await e.getReply()).user_id : e.msg.replace("#删除R信任用户", "").trim();
            // 校准不是string的用户
            let whiteList = (await redisExistAndGetKey(REDIS_YUNZAI_WHITELIST))?.map(item => item.toString()) || [];
            // 重复检测
            if (!whiteList.includes(trustUserId)) {
                e.reply("R信任用户不存在，无须删除！");
                return;
            }
            whiteList = whiteList.filter(item => item !== trustUserId);
            // 放置到Redis里
            await redisSetKey(REDIS_YUNZAI_WHITELIST, whiteList);
            e.reply(`成功删除R信任用户：${trustUserId}`);
        } catch (err) {
            e.reply(`删除R信任用户时发生错误: ${err.message}`);
        }
    }

    /**
     * 查询当前群解析状态
     * @param e
     * @returns {Promise<void>}
     */
    async getGroupResolveStatus(e) {
        try {
            if (!e.isGroup) {
                e.reply("此命令仅在群聊中可用");
                return;
            }

            const groupId = e.group_id;
            const groupResolveKey = `${REDIS_YUNZAI_GROUP_RESOLVE_PREFIX}${groupId}`;
            const groupConfig = await redisGetKey(groupResolveKey) || { enableAll: true, disabled: [] };

            // 构建状态信息
            let statusMsg = `【群${groupId}解析状态】\n`;
            statusMsg += `全局开关: ${groupConfig.enableAll === false ? '❌ 已关闭' : '✅ 已开启'}\n`;
            statusMsg += `\n各解析功能状态:\n`;

            // 遍历所有解析功能
            for (const [key, name] of Object.entries(RESOLVE_CONTROLLER_NAME_ENUM)) {
                const isDisabled = Array.isArray(groupConfig.disabled) && groupConfig.disabled.includes(key);
                const status = groupConfig.enableAll === false ? '❌ 全局关闭' : (isDisabled ? '❌ 已禁用' : '✅ 已启用');
                statusMsg += `${name}(${key}): ${status}\n`;
            }

            e.reply(statusMsg);
        } catch (err) {
            e.reply(`查询解析状态时发生错误: ${err.message}`);
        }
    }

    /**
     * 临时解析功能
     * 使用方法：引用包含链接的消息 + @机器人 + 发送"解析"
     */
    async tempResolve(e) {
        try {
            // 检查是否@了机器人
            const atList = e.message?.filter(item => item.type === 'at') || [];
            const botQQ = e.self_id || Bot.uin;
            const isAtBot = atList.some(at => at.qq == botQQ);

            if (!isAtBot) {
                return false;
            }

            // 有引用消息 - 解析被引用的消息
            if (e.reply_id) {
                const replyMsg = await e.getReply();
                // raw_message 是字符串格式的原始消息
                const replyMsgText = replyMsg?.raw_message || '';

                // 动态导入 tools 插件并调用解析
                const { tools } = await import('./tools.js');
                const toolsPlugin = new tools();
                // 添加 isTempParse 标志以绕过群级别拦截
                const tempE = { ...e, msg: replyMsgText, isTempParse: true };

                const parseResult = await toolsPlugin.tryParseMessage(tempE);

                if (!parseResult) {
                    e.reply(`未能识别被引用消息中的链接`);
                }
                return parseResult;
            }

            e.reply(`请引用要解析的消息`);
            return false;
        } catch (err) {
            e.reply(`临时解析出错: ${err.message}`);
            return false;
        }
    }



    /**
     * 开启解析功能（全部或指定平台）
     * @param e
     * @returns {Promise<void>}
     */
    async enableResolve(e) {
        try {
            if (!e.isGroup) {
                e.reply("此命令仅在群聊中可用");
                return;
            }

            const groupId = e.group_id;
            const groupResolveKey = `${REDIS_YUNZAI_GROUP_RESOLVE_PREFIX}${groupId}`;

            // 提取解析名称列表
            const resolveInput = e.msg.replace(/^#开启解析\s*/, '').trim();
            const resolveNames = resolveInput.split(/\s+/).filter(name => name.length > 0);

            // 如果没有参数，开启所有解析（清空禁用列表）
            if (resolveNames.length === 0) {
                await redisSetKey(groupResolveKey, { enableAll: true, disabled: [] });
                e.reply(`✅ 已开启群${groupId}的所有解析功能`);
                return;
            }

            // 获取当前配置
            const groupConfig = await redisGetKey(groupResolveKey) || { enableAll: true, disabled: [] };

            // 确保 disabled 是数组
            if (!Array.isArray(groupConfig.disabled)) {
                groupConfig.disabled = [];
            }

            const validNames = [];
            const invalidNames = [];
            const enabledNames = [];

            // 处理每个解析名称
            for (const name of resolveNames) {
                // 尝试通过中文名或英文名匹配
                let resolveKey = null;
                if (name in RESOLVE_CONTROLLER_NAME_ENUM) {
                    resolveKey = name;
                } else {
                    for (const [key, value] of Object.entries(RESOLVE_CONTROLLER_NAME_ENUM)) {
                        if (value === name) {
                            resolveKey = key;
                            break;
                        }
                    }
                }

                if (resolveKey) {
                    validNames.push(RESOLVE_CONTROLLER_NAME_ENUM[resolveKey]);
                    // 从禁用列表中移除
                    const index = groupConfig.disabled.indexOf(resolveKey);
                    if (index !== -1) {
                        groupConfig.disabled.splice(index, 1);
                        enabledNames.push(RESOLVE_CONTROLLER_NAME_ENUM[resolveKey]);
                    }
                } else {
                    invalidNames.push(name);
                }
            }

            // 保存配置
            await redisSetKey(groupResolveKey, groupConfig);

            let msg = '';
            if (enabledNames.length > 0) {
                msg += `✅ 已开启解析功能: ${enabledNames.join('、')}\n`;
            }
            if (validNames.length > enabledNames.length) {
                msg += `ℹ️ 以下功能已经是开启状态: ${validNames.filter(n => !enabledNames.includes(n)).join('、')}\n`;
            }
            if (invalidNames.length > 0) {
                msg += `⚠️ 无效的解析名称: ${invalidNames.join('、')}\n`;
                msg += `提示: 可用的解析功能请使用 #R解析状态 查询`;
            }

            e.reply(msg || '未进行任何更改');
        } catch (err) {
            e.reply(`开启解析时发生错误: ${err.message}`);
        }
    }

    /**
     * 关闭解析功能（全部或指定平台）
     * @param e
     * @returns {Promise<void>}
     */
    async disableResolve(e) {
        try {
            if (!e.isGroup) {
                e.reply("此命令仅在群聊中可用");
                return;
            }

            const groupId = e.group_id;
            const groupResolveKey = `${REDIS_YUNZAI_GROUP_RESOLVE_PREFIX}${groupId}`;

            // 提取解析名称列表
            const resolveInput = e.msg.replace(/^#关闭解析\s*/, '').trim();
            const resolveNames = resolveInput.split(/\s+/).filter(name => name.length > 0);

            // 如果没有参数，关闭所有解析
            if (resolveNames.length === 0) {
                await redisSetKey(groupResolveKey, { enableAll: false, disabled: [] });
                e.reply(`❌ 已关闭群${groupId}的所有解析功能`);
                return;
            }

            // 获取当前配置
            const groupConfig = await redisGetKey(groupResolveKey) || { enableAll: true, disabled: [] };

            // 确保 disabled 是数组
            if (!Array.isArray(groupConfig.disabled)) {
                groupConfig.disabled = [];
            }

            const validNames = [];
            const invalidNames = [];
            const disabledNames = [];

            // 处理每个解析名称
            for (const name of resolveNames) {
                // 尝试通过中文名或英文名匹配
                let resolveKey = null;
                if (name in RESOLVE_CONTROLLER_NAME_ENUM) {
                    resolveKey = name;
                } else {
                    for (const [key, value] of Object.entries(RESOLVE_CONTROLLER_NAME_ENUM)) {
                        if (value === name) {
                            resolveKey = key;
                            break;
                        }
                    }
                }

                if (resolveKey) {
                    validNames.push(RESOLVE_CONTROLLER_NAME_ENUM[resolveKey]);
                    // 添加到禁用列表（如果还没有）
                    if (!groupConfig.disabled.includes(resolveKey)) {
                        groupConfig.disabled.push(resolveKey);
                        disabledNames.push(RESOLVE_CONTROLLER_NAME_ENUM[resolveKey]);
                    }
                } else {
                    invalidNames.push(name);
                }
            }

            // 保存配置
            await redisSetKey(groupResolveKey, groupConfig);

            let msg = '';
            if (disabledNames.length > 0) {
                msg += `❌ 已关闭解析功能: ${disabledNames.join('、')}\n`;
            }
            if (validNames.length > disabledNames.length) {
                msg += `ℹ️ 以下功能已经是关闭状态: ${validNames.filter(n => !disabledNames.includes(n)).join('、')}\n`;
            }
            if (invalidNames.length > 0) {
                msg += `⚠️ 无效的解析名称: ${invalidNames.join('、')}\n`;
                msg += `提示: 可用的解析功能请使用 #R解析状态 查询`;
            }

            e.reply(msg || '未进行任何更改');
        } catch (err) {
            e.reply(`关闭解析时发生错误: ${err.message}`);
        }
    }
}

/**
 * 清理垃圾文件
 * @returns {Promise<Object>}
 */
async function autoclearTrash() {
    const dataDirectory = "./data/";
    try {
        const files = await readCurrentDir(dataDirectory);
        let dataClearFileLen = 0;
        for (const file of files) {
            if (/^[0-9a-f]{32}$/.test(file)) {
                await fs.promises.unlink(dataDirectory + file);
                dataClearFileLen++;
            }
        }
        const { files: rTempFileLen, folders: rTempFolderLen } = await deleteFolderRecursive(defaultPath);
        return { dataClearFileLen, rTempFileLen, rTempFolderLen };
    } catch (err) {
        logger.error(err);
        throw err;
    }
}

function autoclear(time) {
    schedule.scheduleJob(time, async function () {
        try {
            const { dataClearFileLen, rTempFileLen, rTempFolderLen } = await autoclearTrash();
            logger.info(`自动清理垃圾完成:\n` +
                `- 清理了${dataClearFileLen}个垃圾文件\n` +
                `- 清理了${rTempFolderLen}个空文件夹\n` +
                `- 清理了${rTempFileLen}个群临时文件`);
        } catch (err) {
            logger.error(`自动清理垃圾时发生错误: ${err.message}`);
        }
    });
}

// 自动清理垃圾
autoclear(autotime);
