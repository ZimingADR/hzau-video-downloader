// ==UserScript==
// @name         狮山智学录播视频下载器
// @namespace    http://tampermonkey.net/
// @version      2.1.0
// @description  下载狮山智学平台的录播视频，支持单视频下载和课程批量下载，可选择视角和视频
// @author       You
// @match        *://resc.hzau.edu.cn/*
// @run-at       document-start
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      resc.hzau.edu.cn
// @connect      s3cluster3.hzau.edu.cn
// ==/UserScript==

(function() {
    'use strict';



    // ========== 配置 ==========
    const API_BASE = 'https://resc.hzau.edu.cn/resc-center';
    const DEFAULT_PAGE_SIZE = 100;
    const DOWNLOAD_ROOT = '课堂录播/'; // 下载根目录

    // 视角代码映射
    const VIEW_MAP = {
        '1': '教师',
        '2': '板书',
        '3': '学生'
    };

    // ========== 工具函数 ==========

    // 从URL中获取参数
    function getQueryParam(name) {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get(name);
    }

    // 从hash中获取参数
    function getHashParam(name) {
        const hash = window.location.hash;
        const params = new URLSearchParams(hash.split('?')[1] || '');
        return params.get(name);
    }

    // 获取resourceId
    function getResourceId() {
        return getHashParam('resourceId') || getQueryParam('resourceId');
    }

    // 格式化文件大小
    function formatSize(val) {
        if (!val) return '未知';
        let num = parseFloat(val);
        // 视频文件一般很大。如果数值小于 100000 (即 100KB)，我们推断 API 返回的是以 MB 为单位的数据。
        if (num < 100000) {
            num = num * 1024 * 1024; // 转换为字节
        }
        if (num < 1024) return num.toFixed(0) + ' B';
        if (num < 1024 * 1024) return (num / 1024).toFixed(2) + ' KB';
        if (num < 1024 * 1024 * 1024) return (num / (1024 * 1024)).toFixed(2) + ' MB';
        return (num / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    // 格式化时间（具体到分钟）
    function formatTime(seconds) {
        if (seconds < 3600) return Math.floor(seconds / 60) + ' 分 ' + Math.floor(seconds % 60) + ' 秒';
        return Math.floor(seconds / 3600) + ' 小时 ' + Math.floor((seconds % 3600) / 60) + ' 分 ' + Math.floor(seconds % 60) + ' 秒';
    }

    // 发送GET请求（使用原生fetch，自动带上Cookie认证）
    function fetchJSON(url) {
        return fetch(url, {
            credentials: 'include'
        })
        .then(response => {
            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }
            return response.text();
        })
        .then(text => {
            try {
                return JSON.parse(text);
            } catch (e) {
                console.error('[HZAU下载器] JSON解析失败，返回内容前200字：', text.substring(0, 200));
                throw new Error('API返回内容不是JSON，可能是未登录或URL错误');
            }
        });
    }

    // 下载文件
    function downloadFile(url, filename, onProgress) {
        return new Promise((resolve, reject) => {
            let startTime = Date.now();
            let lastLoaded = 0;
            let lastTime = startTime;
            
            GM_download({
                url: url,
                name: filename,
                onload: function() {
                    resolve();
                },
                onerror: function(error) {
                    reject(error);
                },
                onprogress: function(progress) {
                    if (onProgress && progress.total) {
                        const percent = ((progress.loaded / progress.total) * 100).toFixed(1);
                        
                        const now = Date.now();
                        const timeDiff = (now - lastTime) / 1000;
                        
                        if (timeDiff >= 0.5 || progress.loaded === progress.total) {
                            const speed = (progress.loaded - lastLoaded) / timeDiff; // bytes/sec
                            lastLoaded = progress.loaded;
                            lastTime = now;
                            
                            const remaining = progress.total - progress.loaded;
                            const eta = speed > 0 ? remaining / speed : 0;
                            
                            const speedMB = (speed / (1024 * 1024)).toFixed(2) + ' MB/s';
                            const etaStr = formatTime(eta);
                            
                            onProgress(percent, speedMB, etaStr);
                        } else if (timeDiff === 0 && lastLoaded === 0) {
                            onProgress(percent, '计算中...', '计算中...');
                        }
                    }
                }
            });
        });
    }

    // 并发任务队列
    async function runTasksWithConcurrency(tasks, limit = 3) {
        const executing = new Set();
        for (const task of tasks) {
            const p = Promise.resolve().then(() => task());
            executing.add(p);
            p.finally(() => executing.delete(p));
            if (executing.size >= limit) {
                await Promise.race(executing);
            }
        }
        await Promise.all(executing);
    }

    // 从资源名称中提取课程名称
    function extractCourseName(resourceName) {
        if (!resourceName) return '未知课程';
        // 格式如：药物化学_录播课_2026-06-17 17:25-18:10
        // 提取第一个下划线之前的部分作为课程名
        const parts = resourceName.split('_');
        if (parts.length > 0) {
            return parts[0];
        }
        return resourceName;
    }

    // 生成下载文件路径
    function generateFilePath(courseName, resourceName, viewName) {
        // 路径格式：课堂录播/课程名称/视频名称_视角.mp4
        const safeCourseName = courseName.replace(/[\\/:*?"<>|]/g, '');
        const safeResourceName = resourceName.replace(/[\\/:*?"<>|]/g, '');
        const safeViewName = viewName.replace(/[\\/:*?"<>|]/g, '');
        return `${DOWNLOAD_ROOT}${safeCourseName}/${safeResourceName}_${safeViewName}.mp4`;
    }

    // ========== API 封装 ==========

    // 获取视频分类信息
    async function getVideoClassInfo(resourceId) {
        // 尝试多个路径（不同模块可能在不同的路径前缀下）
        const paths = [
            `https://resc.hzau.edu.cn/resource-center/videoclass/videoClassInfo?resourceId=${resourceId}`,
            `${API_BASE}/videoclass/videoClassInfo?resourceId=${resourceId}`
        ];

        let lastError = null;
        for (const url of paths) {
            try {
                console.log('[HZAU下载器] 尝试视频信息接口:', url);
                const data = await fetchJSON(url);
                console.log('[HZAU下载器] 视频信息接口成功:', url);
                return data.data || {};
            } catch (error) {
                console.log('[HZAU下载器] 视频信息接口失败:', url, error.message);
                lastError = error;
            }
        }

        throw lastError || new Error('所有路径都失败');
    }

    // 获取学生资源列表
    async function getStudentResourceList(courseId, page = 1, pageSize = DEFAULT_PAGE_SIZE) {
        // 注意：学生空间API在 /resource-center/ 路径下，不是 /resc-center/
        const url = `https://resc.hzau.edu.cn/resource-center/studentSpace/getStudentResourceList?courseId=${courseId}&page=${page}&pageSize=${pageSize}&sortNameType=3&sortRuleType=1`;
        console.log('[HZAU下载器] 请求录播列表:', url);
        const data = await fetchJSON(url);
        console.log('[HZAU下载器] 录播列表返回:', data);

        // 返回资源列表
        const result = data.data || {};
        return result;
    }

    // 获取课程下所有录播
    async function getAllCourseVideos(courseId) {
        const allVideos = [];
        let page = 1;
        let totalPages = 1;

        do {
            const result = await getStudentResourceList(courseId, page, DEFAULT_PAGE_SIZE);

            // 兼容多种数据结构
            const list = result.dataList || result.list || result.records || [];
            allVideos.push(...list);

            // 获取分页信息
            const pageConfig = result.pageConfig || {};
            totalPages = pageConfig.totalPage || pageConfig.pages || result.totalPage || result.pages || 1;

            if (pageConfig.total && pageConfig.pageSize) {
                totalPages = Math.ceil(pageConfig.total / pageConfig.pageSize);
            } else if (result.total && result.pageSize) {
                totalPages = Math.ceil(result.total / result.pageSize);
            }

            page++;
        } while (page <= totalPages);

        return allVideos;
    }

    // ========== UI 样式 ==========

    function addStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .hzau-download-btn {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 6px 14px;
                background: #1890ff;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
                margin: 4px;
                transition: background 0.3s;
            }
            .hzau-download-btn:hover {
                background: #40a9ff;
            }
            .hzau-download-btn:disabled {
                background: #ccc;
                cursor: not-allowed;
            }
            .hzau-download-btn.hzau-batch-btn {
                background: #52c41a;
            }
            .hzau-download-btn.hzau-batch-btn:hover {
                background: #73d13d;
            }
            .hzau-modal {
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: white;
                border-radius: 8px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.2);
                z-index: 100000;
                width: 500px;
                max-height: 80vh;
                display: flex;
                flex-direction: column;
            }
            .hzau-modal-header {
                padding: 16px 20px;
                border-bottom: 1px solid #f0f0f0;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .hzau-modal-header h3 {
                margin: 0;
                font-size: 16px;
                color: #333;
            }
            .hzau-modal-close {
                background: none;
                border: none;
                font-size: 20px;
                cursor: pointer;
                color: #999;
                padding: 0;
                line-height: 1;
            }
            .hzau-modal-close:hover {
                color: #666;
            }
            .hzau-modal-body {
                padding: 16px 20px;
                overflow-y: auto;
                flex: 1;
            }
            .hzau-modal-footer {
                padding: 12px 20px;
                border-top: 1px solid #f0f0f0;
                display: flex;
                justify-content: flex-end;
                gap: 10px;
            }
            .hzau-section {
                margin-bottom: 16px;
            }
            .hzau-section-title {
                font-size: 14px;
                font-weight: 500;
                color: #333;
                margin-bottom: 8px;
            }
            .hzau-checkbox-group {
                display: flex;
                flex-wrap: wrap;
                gap: 12px;
            }
            .hzau-checkbox-item {
                display: flex;
                align-items: center;
                gap: 6px;
                cursor: pointer;
                font-size: 13px;
                color: #666;
            }
            .hzau-checkbox-item input {
                cursor: pointer;
            }
            .hzau-video-list {
                border: 1px solid #f0f0f0;
                border-radius: 4px;
                max-height: 300px;
                overflow-y: auto;
            }
            .hzau-video-item {
                display: flex;
                align-items: center;
                padding: 8px 12px;
                border-bottom: 1px solid #f5f5f5;
                cursor: pointer;
                transition: background 0.2s;
            }
            .hzau-video-item:hover {
                background: #f9f9f9;
            }
            .hzau-video-item:last-child {
                border-bottom: none;
            }
            .hzau-video-item input {
                margin-right: 10px;
                cursor: pointer;
            }
            .hzau-video-item-info {
                flex: 1;
                overflow: hidden;
            }
            .hzau-video-item-name {
                font-size: 13px;
                color: #333;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .hzau-video-item-size {
                font-size: 12px;
                color: #999;
                margin-top: 2px;
            }
            .hzau-select-all {
                display: flex;
                align-items: center;
                padding: 8px 12px;
                background: #fafafa;
                border-bottom: 1px solid #f0f0f0;
                font-size: 13px;
                color: #666;
                cursor: pointer;
            }
            .hzau-select-all input {
                margin-right: 10px;
                cursor: pointer;
            }
            .hzau-float-btn {
                position: fixed;
                top: 50%;
                right: 0;
                transform: translateY(-50%);
                background: #1890ff;
                color: white;
                padding: 12px 8px;
                border-radius: 4px 0 0 4px;
                cursor: pointer;
                z-index: 99998;
                writing-mode: vertical-rl;
                font-size: 14px;
                box-shadow: -2px 0 8px rgba(0,0,0,0.15);
            }
            .hzau-float-btn:hover {
                background: #40a9ff;
            }
            .hzau-float-btn.hzau-batch {
                background: #52c41a;
            }
            .hzau-float-btn.hzau-batch:hover {
                background: #73d13d;
            }
            .hzau-download-panel {
                position: fixed;
                top: 80px;
                right: 20px;
                background: white;
                border-radius: 8px;
                box-shadow: 0 2px 12px rgba(0,0,0,0.15);
                padding: 16px;
                z-index: 99999;
                max-width: 320px;
                max-height: 80vh;
                overflow-y: auto;
            }
            .hzau-download-panel h3 {
                margin: 0 0 12px 0;
                font-size: 16px;
                color: #333;
            }
            .hzau-download-panel .close-btn {
                position: absolute;
                top: 10px;
                right: 10px;
                background: none;
                border: none;
                font-size: 18px;
                cursor: pointer;
                color: #999;
            }
            .hzau-download-panel .video-item {
                padding: 8px;
                border-bottom: 1px solid #eee;
            }
            .hzau-download-panel .video-item:last-child {
                border-bottom: none;
            }
            .hzau-download-panel .video-name {
                font-size: 13px;
                color: #333;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .hzau-download-panel .status {
                font-size: 12px;
                color: #999;
                margin-top: 4px;
            }
            .hzau-download-panel .status.success {
                color: #52c41a;
            }
            .hzau-download-panel .status.error {
                color: #ff4d4f;
            }
            .hzau-download-panel .progress-bar {
                width: 100%;
                height: 4px;
                background: #f0f0f0;
                border-radius: 2px;
                margin-top: 8px;
                overflow: hidden;
            }
            .hzau-download-panel .progress-fill {
                height: 100%;
                background: #1890ff;
                transition: width 0.3s;
            }
            .hzau-download-panel .item-progress-bar {
                width: 100%;
                height: 2px;
                background: #f0f0f0;
                border-radius: 1px;
                margin-top: 4px;
                overflow: hidden;
                display: none;
            }
            .hzau-download-panel .item-progress-fill {
                height: 100%;
                background: #1890ff;
                width: 0%;
                transition: width 0.3s linear;
            }
            .hzau-mask {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0,0,0,0.5);
                z-index: 99999;
            }
            .hzau-summary {
                margin-top: 12px;
                padding-top: 12px;
                border-top: 1px solid #eee;
                font-size: 13px;
            }
        `;
        document.head.appendChild(style);
    }

    // ========== 模态框组件 ==========

    function createModal(title) {
        // 创建遮罩
        const mask = document.createElement('div');
        mask.className = 'hzau-mask';

        // 创建模态框
        const modal = document.createElement('div');
        modal.className = 'hzau-modal';
        modal.innerHTML = `
            <div class="hzau-modal-header">
                <h3>${title}</h3>
                <button class="hzau-modal-close">×</button>
            </div>
            <div class="hzau-modal-body"></div>
            <div class="hzau-modal-footer"></div>
        `;

        // 关闭按钮
        modal.querySelector('.hzau-modal-close').addEventListener('click', () => {
            mask.remove();
            modal.remove();
        });

        // 点击遮罩关闭
        mask.addEventListener('click', () => {
            mask.remove();
            modal.remove();
        });

        // 阻止模态框内容区域的点击事件冒泡
        modal.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        document.body.appendChild(mask);
        document.body.appendChild(modal);

        return {
            modal,
            mask,
            body: modal.querySelector('.hzau-modal-body'),
            footer: modal.querySelector('.hzau-modal-footer'),
            close: () => {
                mask.remove();
                modal.remove();
            }
        };
    }

    // ========== 下载进度面板 ==========

    function createDownloadPanel(title) {
        const panel = document.createElement('div');
        panel.className = 'hzau-download-panel';
        panel.innerHTML = `
            <button class="close-btn">×</button>
            <h3>${title} <span class="hzau-global-progress-text" style="font-size:13px; font-weight:normal; color:#666;">(0/0)</span></h3>
            <div class="progress-bar" style="margin-bottom: 12px; height: 6px;"><div class="progress-fill" style="width: 0%"></div></div>
            <div class="video-list"></div>
        `;
        panel.querySelector('.close-btn').addEventListener('click', () => {
            panel.remove();
        });
        document.body.appendChild(panel);
        return panel;
    }

    function addDownloadItem(panel, name) {
        const list = panel.querySelector('.video-list');
        const item = document.createElement('div');
        item.className = 'video-item';
        item.innerHTML = `
            <div class="video-name" title="${name}">${name}</div>
            <div class="status">等待中</div>
            <div class="item-progress-bar"><div class="item-progress-fill"></div></div>
        `;
        list.appendChild(item);
        return item;
    }

    function updateItemProgress(item, percent) {
        const bar = item.querySelector('.item-progress-bar');
        const fill = item.querySelector('.item-progress-fill');
        bar.style.display = 'block';
        fill.style.width = percent + '%';
        if (percent === 100 || percent === 0) {
            setTimeout(() => { if (percent === 100 || percent === 0) bar.style.display = 'none'; }, 1000);
        }
    }

    function updateDownloadItem(item, status, isSuccess = false, isError = false) {
        const statusEl = item.querySelector('.status');
        statusEl.textContent = status;
        statusEl.className = 'status';
        if (isSuccess) statusEl.classList.add('success');
        if (isError) statusEl.classList.add('error');
    }

    function updateProgress(panel, current, total) {
        const progress = total > 0 ? (current / total) * 100 : 0;
        panel.querySelector('.progress-fill').style.width = progress + '%';
        const textEl = panel.querySelector('.hzau-global-progress-text');
        if (textEl) {
            textEl.textContent = `(${current}/${total})`;
        }
    }

    // ========== 视频播放页面功能 ==========

    async function initVideoPage() {
        const resourceId = getResourceId();
        if (!resourceId) return;

        console.log('[HZAU下载器] 检测到视频页面，resourceId:', resourceId);

        // 等待页面加载完成（设置3秒超时，如果找不到则忽略，确保后续能正常注入悬浮按钮）
        try {
            await waitForElement('.video-container, .player-container, .preview-container, #app', 3000);
        } catch (e) {
            console.warn('[HZAU下载器] 等待元素超时，但我们将继续尝试注入下载按钮');
        }

        // 获取视频信息
        try {
            const videoInfo = await getVideoClassInfo(resourceId);
            const videoList = videoInfo.videoList || [];
            const resourceName = videoInfo.resourceName || '录播视频';
            const courseName = extractCourseName(resourceName);

            console.log('[HZAU下载器] 获取到视频信息:', videoList.length, '个机位');

            // 创建下载按钮
            createVideoDownloadButton(videoList, resourceName, courseName);

        } catch (error) {
            console.error('[HZAU下载器] 获取视频信息失败:', error);
        }
    }

    function createVideoDownloadButton(videoList, resourceName, courseName) {
        // 检查是否已存在
        if (document.querySelector('.hzau-video-download-float')) return;

        const floatBtn = document.createElement('div');
        floatBtn.className = 'hzau-float-btn hzau-video-download-float';
        floatBtn.textContent = '下载视频';
        floatBtn.addEventListener('click', () => {
            showVideoDownloadModal(videoList, resourceName, courseName);
        });
        document.body.appendChild(floatBtn);
    }

    function showVideoDownloadModal(videoList, resourceName, courseName) {
        const { modal, body, footer, close } = createModal('下载录播视频');

        // 视角选择
        const viewSection = document.createElement('div');
        viewSection.className = 'hzau-section';
        viewSection.innerHTML = `
            <div class="hzau-section-title">选择下载视角（可多选）</div>
            <div class="hzau-checkbox-group">
                ${videoList.map(video => `
                    <label class="hzau-checkbox-item">
                        <input type="checkbox" value="${video.videoCode}" checked>
                        ${video.videoName}（${formatSize(video.videoSize)}）
                    </label>
                `).join('')}
            </div>
        `;
        body.appendChild(viewSection);

        // 视频信息
        const infoSection = document.createElement('div');
        infoSection.className = 'hzau-section';
        infoSection.innerHTML = `
            <div class="hzau-section-title">视频信息</div>
            <div style="font-size: 13px; color: #666; line-height: 1.8;">
                <div>视频名称：${resourceName}</div>
                <div>课程名称：${courseName}</div>
                <div>下载路径：${DOWNLOAD_ROOT}${courseName}/</div>
            </div>
        `;
        body.appendChild(infoSection);

        // 底部按钮
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'hzau-download-btn';
        cancelBtn.style.background = '#f0f0f0';
        cancelBtn.style.color = '#666';
        cancelBtn.textContent = '取消';
        cancelBtn.addEventListener('click', close);

        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'hzau-download-btn';
        downloadBtn.textContent = '开始下载';
        downloadBtn.addEventListener('click', () => {
            // 获取选中的视角
            const checkedViews = viewSection.querySelectorAll('input:checked');
            const selectedCodes = Array.from(checkedViews).map(cb => cb.value);

            if (selectedCodes.length === 0) {
                alert('请至少选择一个视角');
                return;
            }

            // 筛选要下载的视频
            const selectedVideos = videoList.filter(v => selectedCodes.includes(v.videoCode));

            close();
            startVideoDownload(selectedVideos, resourceName, courseName);
        });

        footer.appendChild(cancelBtn);
        footer.appendChild(downloadBtn);
    }

    async function startVideoDownload(selectedVideos, resourceName, courseName) {
        const panel = createDownloadPanel('下载中...');

        let successCount = 0;
        let failCount = 0;
        let completed = 0;

        const tasks = selectedVideos.map((video) => {
            const viewName = VIEW_MAP[video.videoCode] || video.videoName;
            const itemName = `${video.videoName}`;
            const item = addDownloadItem(panel, itemName);

            return async () => {
                try {
                    updateDownloadItem(item, '下载中... 0%');

                    const filePath = generateFilePath(courseName, resourceName, viewName);
                    console.log('[HZAU下载器] 下载到:', filePath);

                    await downloadFile(video.videoPath, filePath, (percent, speed, eta) => {
                        updateDownloadItem(item, `下载中... ${percent}% | ${speed} | 剩余 ${eta}`);
                        updateItemProgress(item, percent);
                    });

                    updateDownloadItem(item, '下载完成', true);
                    successCount++;
                } catch (error) {
                    console.error('下载失败:', error);
                    updateDownloadItem(item, '下载失败', false, true);
                    failCount++;
                }

                completed++;
                updateItemProgress(item, 0);
                updateProgress(panel, completed, selectedVideos.length);
            };
        });

        const globalStartTime = Date.now();
        await runTasksWithConcurrency(tasks, 3);
        const globalEndTime = Date.now();
        
        let timeHtml = '';
        if (selectedVideos.length >= 2) {
            const totalSeconds = (globalEndTime - globalStartTime) / 1000;
            timeHtml = `<div style="color: #666; margin-top: 4px; font-size: 12px;">总耗时：${formatTime(totalSeconds)}</div>`;
        }

        // 添加总结
        const summary = document.createElement('div');
        summary.className = 'hzau-summary';
        summary.innerHTML = `
            <div style="margin-bottom: 4px;">下载完成！</div>
            <div style="color: #52c41a;">成功: ${successCount} 个</div>
            <div style="color: #ff4d4f;">失败: ${failCount} 个</div>
            ${timeHtml}
            <div style="color: #999; margin-top: 4px; font-size: 12px;">
                保存路径：${DOWNLOAD_ROOT}${courseName}/
            </div>
        `;
        panel.querySelector('.video-list').appendChild(summary);
        panel.querySelector('h3').textContent = '下载完成';
    }

    // ========== 课程列表页面功能 ==========

    function initCourseListPage() {
        // 检测是否在课程录播列表页面
        if (!window.location.hash.includes('/personal/index') &&
            !window.location.hash.includes('/course/index')) {
            return;
        }

        console.log('[HZAU下载器] 检测到课程列表页面');

        // 等待列表加载
        waitForElement('.file-list, .resource-list, table').then(() => {
            addBatchDownloadButton();
        });
    }

    function addBatchDownloadButton() {
        // 检查是否已经添加过
        if (document.querySelector('.hzau-batch-download-btn')) return;

        const batchBtn = document.createElement('button');
        batchBtn.className = 'hzau-download-btn hzau-batch-btn hzau-batch-download-btn';
        batchBtn.innerHTML = '📦 批量下载录播';
        batchBtn.style.margin = '10px';
        batchBtn.addEventListener('click', handleBatchDownload);

        // 插入到页面合适位置
        const toolbar = document.querySelector('.toolbar, .page-header, .ant-page-header') ||
                        document.querySelector('.file-list')?.parentElement;

        if (toolbar) {
            toolbar.insertBefore(batchBtn, toolbar.firstChild);
        } else {
            // 找不到位置就放浮动按钮
            const floatBtn = document.createElement('div');
            floatBtn.className = 'hzau-float-btn hzau-batch hzau-batch-download-float';
            floatBtn.textContent = '批量下载';
            floatBtn.addEventListener('click', handleBatchDownload);
            document.body.appendChild(floatBtn);
        }
    }

    async function handleBatchDownload() {
        // 从当前页面获取courseId
        let courseId = getCurrentCourseId();

        if (!courseId) {
            alert('未找到课程ID，请先进入具体的课程文件夹');
            return;
        }

        // 显示加载中
        const loadingModal = createModal('批量下载');
        loadingModal.body.innerHTML = '<div style="text-align: center; padding: 40px; color: #999;">正在获取录播列表...</div>';

        try {
            // 获取所有录播列表
            const videos = await getAllCourseVideos(courseId);

            console.log('[HZAU下载器] 获取到', videos.length, '个录播');

            if (videos.length === 0) {
                loadingModal.body.innerHTML = '<div style="text-align: center; padding: 40px; color: #999;">未找到录播视频</div>';
                setTimeout(() => loadingModal.close(), 2000);
                return;
            }

            loadingModal.close();
            showBatchDownloadModal(videos);

        } catch (error) {
            console.error('[HZAU下载器] 获取录播列表失败:', error);
            loadingModal.body.innerHTML = `<div style="text-align: center; padding: 40px; color: #ff4d4f;">获取失败：${error.message}</div>`;
        }
    }

    function showBatchDownloadModal(videos) {
        const { modal, body, footer, close } = createModal('批量下载录播');

        // 获取课程名（从第一个视频提取）
        const courseName = extractCourseName(videos[0]?.resourceName || '');

        // 视角选择
        const viewSection = document.createElement('div');
        viewSection.className = 'hzau-section';
        viewSection.innerHTML = `
            <div class="hzau-section-title">选择下载视角（可多选）</div>
            <div class="hzau-checkbox-group">
                <label class="hzau-checkbox-item">
                    <input type="checkbox" value="1" checked>
                    教师机位
                </label>
                <label class="hzau-checkbox-item">
                    <input type="checkbox" value="2">
                    板书机位
                </label>
                <label class="hzau-checkbox-item">
                    <input type="checkbox" value="3">
                    学生机位
                </label>
            </div>
        `;
        body.appendChild(viewSection);

        // 视频列表
        const listSection = document.createElement('div');
        listSection.className = 'hzau-section';
        listSection.innerHTML = `
            <div class="hzau-section-title">选择要下载的视频（共${videos.length}个）</div>
            <div class="hzau-video-list">
                <div class="hzau-select-all">
                    <input type="checkbox" id="hzau-select-all" checked>
                    <label for="hzau-select-all">全选</label>
                </div>
                <div class="hzau-video-items">
                    ${videos.map((video, index) => `
                        <div class="hzau-video-item">
                            <input type="checkbox" value="${index}" checked class="hzau-video-checkbox">
                            <div class="hzau-video-item-info">
                                <div class="hzau-video-item-name">${video.resourceName || `录播${index+1}`}</div>
                                <div class="hzau-video-item-size">${formatSize(video.resourceSize)}</div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
        body.appendChild(listSection);

        // 全选功能
        const selectAllCheckbox = listSection.querySelector('#hzau-select-all');
        const videoCheckboxes = listSection.querySelectorAll('.hzau-video-checkbox');

        selectAllCheckbox.addEventListener('change', () => {
            videoCheckboxes.forEach(cb => {
                cb.checked = selectAllCheckbox.checked;
            });
        });

        videoCheckboxes.forEach(cb => {
            cb.addEventListener('change', () => {
                const allChecked = Array.from(videoCheckboxes).every(c => c.checked);
                selectAllCheckbox.checked = allChecked;
            });
        });

        // 下载路径信息
        const pathInfo = document.createElement('div');
        pathInfo.style.cssText = 'font-size: 12px; color: #999; margin-top: 8px;';
        pathInfo.textContent = `下载路径：${DOWNLOAD_ROOT}${courseName}/`;
        listSection.appendChild(pathInfo);

        // 底部按钮
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'hzau-download-btn';
        cancelBtn.style.background = '#f0f0f0';
        cancelBtn.style.color = '#666';
        cancelBtn.textContent = '取消';
        cancelBtn.addEventListener('click', close);

        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'hzau-download-btn hzau-batch-btn';
        downloadBtn.textContent = '开始下载';
        downloadBtn.addEventListener('click', () => {
            // 获取选中的视角
            const checkedViews = viewSection.querySelectorAll('input:checked');
            const selectedViewCodes = Array.from(checkedViews).map(cb => cb.value);

            if (selectedViewCodes.length === 0) {
                alert('请至少选择一个视角');
                return;
            }

            // 获取选中的视频
            const checkedVideos = listSection.querySelectorAll('.hzau-video-checkbox:checked');
            const selectedIndices = Array.from(checkedVideos).map(cb => parseInt(cb.value));

            if (selectedIndices.length === 0) {
                alert('请至少选择一个视频');
                return;
            }

            const selectedVideos = selectedIndices.map(i => videos[i]);

            close();
            startBatchDownload(selectedVideos, selectedViewCodes, courseName);
        });

        footer.appendChild(cancelBtn);
        footer.appendChild(downloadBtn);
    }

    async function startBatchDownload(selectedVideos, selectedViewCodes, courseName) {
        const panel = createDownloadPanel('批量下载中...');

        let successCount = 0;
        let failCount = 0;
        let completed = 0;
        const totalTasks = selectedVideos.length * selectedViewCodes.length;

        const tasks = [];

        for (let i = 0; i < selectedVideos.length; i++) {
            const video = selectedVideos[i];
            const resourceName = video.resourceName || `录播${i+1}`;
            const item = addDownloadItem(panel, resourceName);

            tasks.push(async () => {
                try {
                    updateDownloadItem(item, '获取视频地址...');

                    // 获取视频地址
                    const videoInfo = await getVideoClassInfo(video.id);
                    const videoList = videoInfo.videoList || [];

                    // 筛选选中的视角
                    const viewVideos = videoList.filter(v => selectedViewCodes.includes(v.videoCode));

                    if (viewVideos.length === 0) {
                        updateDownloadItem(item, '无可用视角', false, true);
                        failCount += selectedViewCodes.length;
                        completed += selectedViewCodes.length;
                        updateProgress(panel, completed, totalTasks);
                        return;
                    }

                    updateDownloadItem(item, `等待下载... (0/${viewVideos.length})`);

                    // 逐个下载视角
                    let viewSuccess = 0;
                    let viewFail = 0;

                    for (let j = 0; j < viewVideos.length; j++) {
                        const viewVideo = viewVideos[j];
                        const viewName = VIEW_MAP[viewVideo.videoCode] || viewVideo.videoName;

                        try {
                            const filePath = generateFilePath(courseName, resourceName, viewName);
                            updateDownloadItem(item, `下载中... (${viewSuccess + viewFail + 1}/${viewVideos.length}) 0%`);
                            
                            await downloadFile(viewVideo.videoPath, filePath, (percent, speed, eta) => {
                                updateDownloadItem(item, `下载中... (${viewSuccess + viewFail + 1}/${viewVideos.length}) ${percent}% | ${speed} | 剩余 ${eta}`);
                                updateItemProgress(item, percent);
                            });
                            
                            viewSuccess++;
                            successCount++;
                        } catch (error) {
                            console.error('下载失败:', error);
                            viewFail++;
                            failCount++;
                        }

                        completed++;
                        updateItemProgress(item, 0); // 重置进度条以便后续使用或消失
                        updateDownloadItem(item, `下载中... (${viewSuccess + viewFail}/${viewVideos.length})`);
                        updateProgress(panel, completed, totalTasks);
                    }

                    if (viewFail === 0) {
                        updateDownloadItem(item, `下载完成 (${viewSuccess}个视角)`, true);
                    } else {
                        updateDownloadItem(item, `完成 ${viewSuccess}成功 ${viewFail}失败`, viewFail === 0, viewFail > 0);
                    }

                } catch (error) {
                    console.error('获取视频信息失败:', error);
                    updateDownloadItem(item, '获取失败', false, true);
                    failCount += selectedViewCodes.length;
                    completed += selectedViewCodes.length;
                    updateProgress(panel, completed, totalTasks);
                }
            });
        }

        const globalStartTime = Date.now();
        await runTasksWithConcurrency(tasks, 3);
        const globalEndTime = Date.now();

        let timeHtml = '';
        if (totalTasks >= 2) {
            const totalSeconds = (globalEndTime - globalStartTime) / 1000;
            timeHtml = `<div style="color: #666; margin-top: 4px; font-size: 12px;">总耗时：${formatTime(totalSeconds)}</div>`;
        }

        // 完成总结
        const summary = document.createElement('div');
        summary.className = 'hzau-summary';
        summary.innerHTML = `
            <div style="margin-bottom: 4px;">全部下载完成！</div>
            <div style="color: #52c41a;">成功: ${successCount} 个</div>
            <div style="color: #ff4d4f;">失败: ${failCount} 个</div>
            ${timeHtml}
            <div style="color: #999; margin-top: 4px; font-size: 12px;">
                保存路径：${DOWNLOAD_ROOT}${courseName}/
            </div>
        `;
        panel.querySelector('.video-list').appendChild(summary);
        panel.querySelector('h3').textContent = '批量下载完成';
    }

    // 获取当前课程ID
    function getCurrentCourseId() {
        // 方法1：尝试从页面的全局变量中找
        if (window.__INITIAL_STATE__?.course?.id) {
            return window.__INITIAL_STATE__.course.id;
        }

        // 方法2：尝试从当前URL的hash中找
        const hash = window.location.hash;
        const match = hash.match(/courseId[=/:]([a-zA-Z0-9]+)/);
        if (match) {
            return match[1];
        }

        // 方法3：尝试从页面中的链接找
        const links = document.querySelectorAll('a[href*="courseId"]');
        for (const link of links) {
            const href = link.getAttribute('href');
            const m = href.match(/courseId[=/:]([a-zA-Z0-9]+)/);
            if (m) {
                return m[1];
            }
        }

        // 方法4：尝试从列表中的元素获取courseId
        const firstVideo = document.querySelector('[data-course-id], .course-id');
        if (firstVideo) {
            return firstVideo.getAttribute('data-course-id') || firstVideo.getAttribute('course-id');
        }

        // 方法5：从网络请求中获取
        const entries = performance.getEntriesByType('resource');
        for (const entry of entries) {
            if (entry.name.includes('getStudentResourceList')) {
                const match = entry.name.match(/courseId=([a-zA-Z0-9]+)/);
                if (match) {
                    return match[1];
                }
            }
        }

        console.warn('[HZAU下载器] 所有方法都未能获取到courseId');
        return null;
    }

    // ========== 工具函数 ==========

    // 等待元素出现
    function waitForElement(selector, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();

            function check() {
                const element = document.querySelector(selector);
                if (element) {
                    resolve(element);
                } else if (Date.now() - startTime > timeout) {
                    reject(new Error('等待元素超时: ' + selector));
                } else {
                    setTimeout(check, 500);
                }
            }

            check();
        });
    }

    // ========== 主入口 ==========

    function init() {
        console.log('[HZAU下载器] 脚本已加载 v2.0.6');

        // 添加样式
        addStyles();

        // 检测页面类型并初始化对应功能
        function detectAndInit() {
            const resourceId = getResourceId();

            if (resourceId) {
                // 视频播放页面
                initVideoPage();
            } else {
                // 课程列表页面
                initCourseListPage();
            }
        }

        // 初始检测
        detectAndInit();

        // 监听hash变化（单页应用）
        let lastHash = window.location.hash;
        setInterval(() => {
            if (window.location.hash !== lastHash) {
                lastHash = window.location.hash;
                console.log('[HZAU下载器] 页面变化，重新检测');
                setTimeout(detectAndInit, 1000);
            }
        }, 1000);
    }

    // 启动
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
