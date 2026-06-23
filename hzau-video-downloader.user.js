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
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      resc.hzau.edu.cn
// @connect      s3cluster3.hzau.edu.cn
// ==/UserScript==

(function() {
    'use strict';


    // ========== 动态配置管理 ==========
    const DEFAULT_CONFIG = {
        concurrencyLimit: 3,
        batchDefaultViews: ['1', '2', '3'],
        singleDefaultViews: ['1', '2', '3'],
        downloadRoot: '课堂录播/'
    };

    function getConfig(key) {
        let saved = GM_getValue('hzau_config', null);
        if (saved) {
            try {
                const config = JSON.parse(saved);
                if (config[key] !== undefined) return config[key];
            } catch (e) {}
        }
        return DEFAULT_CONFIG[key];
    }

    function setConfig(key, value) {
        let saved = GM_getValue('hzau_config', null);
        let config = saved ? JSON.parse(saved) : { ...DEFAULT_CONFIG };
        config[key] = value;
        GM_setValue('hzau_config', JSON.stringify(config));
    }

    // ========== API配置 ==========
    const API_BASE = 'https://resc.hzau.edu.cn/resc-center';
    const DEFAULT_PAGE_SIZE = 100;

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

    function parseSizeToBytes(val) {
        if (!val) return 0;
        let num = parseFloat(val);
        if (num < 100000) {
            return num * 1024 * 1024;
        }
        return num;
    }

    // 格式化文件大小
    function formatSize(val) {
        let num = parseSizeToBytes(val);
        if (num === 0) return '未知';
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

    // 发送GET请求（使用原生fetch，带重试机制，自动带上Cookie认证）
    async function fetchJSON(url, maxRetries = 3, delayMs = 2000) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                const response = await fetch(url, { credentials: 'include' });
                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }
                const text = await response.text();
                try {
                    return JSON.parse(text);
                } catch (e) {
                    console.error('[HZAU下载器] JSON解析失败，返回内容前200字：', text.substring(0, 200));
                    throw new Error('API返回内容不是JSON，可能是未登录或URL错误');
                }
            } catch (error) {
                if (i === maxRetries - 1) throw error;
                console.warn(`[HZAU下载器] 请求失败，${delayMs}ms后重试 (${i + 1}/${maxRetries}):`, url);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }

    function saveHistory(historyObj) {
        let histories = [];
        try {
            const historyStr = GM_getValue('hzau_history', '[]');
            histories = JSON.parse(historyStr);
        } catch(e) {}
        histories.unshift(historyObj);
        if (histories.length > 50) histories = histories.slice(0, 50);
        GM_setValue('hzau_history', JSON.stringify(histories));
    }

    // 下载文件
    function downloadFile(url, filename, onProgress) {
        return new Promise((resolve, reject) => {
            let startTime = Date.now();
            let rawLastLoaded = 0;
            let uiLastTime = startTime;
            let accumulatedDelta = 0;
            
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
                        const rawDelta = progress.loaded - rawLastLoaded;
                        rawLastLoaded = progress.loaded;
                        accumulatedDelta += rawDelta;
                        
                        const now = Date.now();
                        if ((now - uiLastTime) >= 500 || progress.loaded === progress.total) {
                            uiLastTime = now;
                            const percent = ((progress.loaded / progress.total) * 100).toFixed(1);
                            const elapsedTime = (now - startTime) / 1000;
                            let speed = 0;
                            let eta = 0;
                            if (elapsedTime > 0.1) {
                                speed = progress.loaded / elapsedTime; // 真·平均速度 bytes/sec
                                const remaining = progress.total - progress.loaded;
                                eta = speed > 0 ? remaining / speed : 0;
                            }
                            
                            const speedMB = speed > 0 ? (speed / (1024 * 1024)).toFixed(2) + ' MB/s' : '计算中...';
                            const etaStr = speed > 0 ? formatTime(eta) : '计算中...';
                            
                            onProgress(percent, speedMB, etaStr, accumulatedDelta, speed, eta);
                            accumulatedDelta = 0;
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

    // 生成安全且截断的文件名/路径名
    function getSafeFileName(name, maxLength = 80) {
        if (!name) return '未命名';
        let safe = name.replace(/[\\/:*?"<>|]/g, '').trim();
        if (safe.length > maxLength) {
            safe = safe.substring(0, maxLength).trim() + '...';
        }
        return safe;
    }

    // 为元素添加垂直拖拽支持
    function makeDraggable(element) {
        let isDragging = false;
        let hasMoved = false;
        let startY = 0;
        let startTop = 0;

        element.addEventListener('mousedown', e => {
            isDragging = true;
            hasMoved = false;
            startY = e.clientY;
            startTop = parseInt(window.getComputedStyle(element).top) || 0;
            element.style.transition = 'none';
            e.preventDefault(); // prevent text selection
        });

        document.addEventListener('mousemove', e => {
            if (!isDragging) return;
            if (Math.abs(e.clientY - startY) > 5) {
                hasMoved = true;
            }
            const deltaY = e.clientY - startY;
            element.style.top = `${startTop + deltaY}px`;
            // 移除原本垂直居中的 transform，让 top 完全生效
            element.style.transform = 'none';
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                element.style.transition = '';
            }
        });

        // 拦截并吃掉拖拽结束时的原生点击事件
        element.addEventListener('click', e => {
            if (hasMoved) {
                e.stopPropagation();
                e.preventDefault();
            }
        }, true); // 使用捕获阶段
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
                margin: 0;
                font-size: 16px;
                color: #333;
                padding-right: 40px;
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
            .hzau-download-panel .min-btn {
                position: absolute;
                top: 10px;
                right: 32px;
                background: none;
                border: none;
                font-size: 18px;
                cursor: pointer;
                color: #999;
            }
            .hzau-download-panel .min-btn:hover,
            .hzau-download-panel .close-btn:hover {
                color: #666;
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

        // 集中关闭逻辑
        const closeModal = () => {
            mask.remove();
            modal.remove();
            document.removeEventListener('keydown', handleKeyDown);
        };

        // ESC键监听
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') closeModal();
        };
        document.addEventListener('keydown', handleKeyDown);

        // 关闭按钮
        modal.querySelector('.hzau-modal-close').addEventListener('click', closeModal);

        // 点击遮罩关闭
        mask.addEventListener('click', closeModal);

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
            close: closeModal
        };
    }

    // ========== 下载进度面板 ==========

    function createDownloadPanel(title) {
        const panel = document.createElement('div');
        panel.className = 'hzau-download-panel';
        panel.innerHTML = `
            <button class="min-btn" title="最小化/恢复">-</button>
            <button class="close-btn" title="关闭">×</button>
            <h3>${title} <span class="hzau-global-progress-text" style="font-size:13px; font-weight:normal; color:#666;">(0/0)</span></h3>
            <div class="panel-content" style="margin-top: 12px;">
                <div class="progress-bar" style="margin-bottom: 12px; height: 6px;"><div class="progress-fill" style="width: 0%"></div></div>
                <div class="video-list"></div>
            </div>
        `;
        const closePanel = () => {
            panel.remove();
            document.removeEventListener('keydown', handleKeyDown);
        };
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') closePanel();
        };
        document.addEventListener('keydown', handleKeyDown);

        panel.querySelector('.close-btn').addEventListener('click', closePanel);
        panel.querySelector('.min-btn').addEventListener('click', () => {
            const content = panel.querySelector('.panel-content');
            if (content.style.display === 'none') {
                content.style.display = 'block';
                panel.querySelector('.min-btn').textContent = '-';
            } else {
                content.style.display = 'none';
                panel.querySelector('.min-btn').textContent = '+';
            }
        });
        document.body.appendChild(panel);
        makeDraggable(panel);
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

    // ========== 全局进度追踪器 ==========
    class GlobalProgressTracker {
        constructor(totalTasks, concurrency) {
            this.totalTasks = totalTasks;
            this.concurrency = concurrency;
            this.tasks = new Map();
            this.startTime = Date.now();
            this.totalDiscoveredBytes = 0;
            this.discoveredCount = 0;
            this.totalLoadedBytes = 0;
        }

        addDiscoveredResourceBytes(bytes) {
            this.totalDiscoveredBytes += bytes;
            this.discoveredCount++;
        }

        updateTask(id, status, eta = 0, rawDelta = 0) {
            if (!this.tasks.has(id)) {
                this.tasks.set(id, { status: 'pending', eta: 0 });
            }
            const t = this.tasks.get(id);
            t.status = status;
            t.eta = eta;
            this.totalLoadedBytes += rawDelta;
        }

        getStats() {
            const elapsedTime = (Date.now() - this.startTime) / 1000;
            const globalSpeed = elapsedTime > 1 ? this.totalLoadedBytes / elapsedTime : 0;
            const speedStr = globalSpeed > 0 ? (globalSpeed / (1024 * 1024)).toFixed(2) + ' MB/s' : '计算中...';

            const runningTasks = Array.from(this.tasks.values()).filter(t => t.status === 'running');
            const doneTasks = Array.from(this.tasks.values()).filter(t => t.status === 'done');
            const pendingCount = this.totalTasks - runningTasks.length - doneTasks.length;

            const a = runningTasks.length > 0 ? Math.max(...runningTasks.map(t => t.eta)) : 0;

            let avgTaskTime = 0;
            if (this.discoveredCount > 0 && globalSpeed > 0) {
                const avgBytesPerTask = this.totalDiscoveredBytes / this.discoveredCount;
                const speedPerTask = globalSpeed / this.concurrency;
                avgTaskTime = avgBytesPerTask / speedPerTask;
            }

            const batches = Math.floor(pendingCount / this.concurrency);
            const remainder = pendingCount % this.concurrency;
            
            const b = batches * avgTaskTime;
            const c = remainder > 0 ? avgTaskTime : 0;

            const totalEtaSeconds = a + b + c;
            
            let etaStr = globalSpeed > 0 ? formatTime(totalEtaSeconds) : '计算中...';
            if (pendingCount === 0 && runningTasks.length === 0) {
                etaStr = '0 秒';
            }

            return {
                speedStr,
                etaStr
            };
        }
    }

    function updateProgress(panel, current, total, globalStats = null) {
        const progress = total > 0 ? (current / total) * 100 : 0;
        panel.querySelector('.progress-fill').style.width = progress + '%';
        const textEl = panel.querySelector('.hzau-global-progress-text');
        if (textEl) {
            let txt = `(${current}/${total})`;
            if (globalStats) {
                txt += ` | 总速度: ${globalStats.speedStr} | 预计还需: ${globalStats.etaStr}`;
            }
            textEl.textContent = txt;
        }
    }

    // ========== 设置面板 ==========

    function showSettingsModal() {
        const { modal, body, footer, close } = createModal('下载器设置');

        const concurrency = getConfig('concurrencyLimit');
        const batchViews = getConfig('batchDefaultViews');
        const singleViews = getConfig('singleDefaultViews');
        const downloadRoot = getConfig('downloadRoot');

        const isChecked = (arr, val) => arr.includes(val) ? 'checked' : '';

        body.innerHTML = `
            <div class="hzau-section">
                <div class="hzau-section-title">并发下载数目</div>
                <input type="number" id="hzau-cfg-concurrency" value="${concurrency}" min="1" max="10" style="width:100%; padding:6px; border:1px solid #d9d9d9; border-radius:4px;">
                <div style="font-size:12px; color:#999; margin-top:4px;">过高可能会卡顿或被封禁，建议保持 3~5。</div>
            </div>
            <div class="hzau-section">
                <div class="hzau-section-title">下载位置</div>
                <input type="text" id="hzau-cfg-root" value="${downloadRoot}" style="width:100%; padding:6px; border:1px solid #d9d9d9; border-radius:4px;">
                <div style="font-size:12px; color:#999; margin-top:4px;">相对路径请以斜杠 / 结尾。</div>
            </div>
            <div class="hzau-section">
                <div class="hzau-section-title">单视频默认下载机位</div>
                <div class="hzau-checkbox-group" id="hzau-cfg-single">
                    <label class="hzau-checkbox-item"><input type="checkbox" value="1" ${isChecked(singleViews, '1')}> 教师</label>
                    <label class="hzau-checkbox-item"><input type="checkbox" value="2" ${isChecked(singleViews, '2')}> 板书</label>
                    <label class="hzau-checkbox-item"><input type="checkbox" value="3" ${isChecked(singleViews, '3')}> 学生</label>
                </div>
            </div>
            <div class="hzau-section">
                <div class="hzau-section-title">批量默认下载机位</div>
                <div class="hzau-checkbox-group" id="hzau-cfg-batch">
                    <label class="hzau-checkbox-item"><input type="checkbox" value="1" ${isChecked(batchViews, '1')}> 教师</label>
                    <label class="hzau-checkbox-item"><input type="checkbox" value="2" ${isChecked(batchViews, '2')}> 板书</label>
                    <label class="hzau-checkbox-item"><input type="checkbox" value="3" ${isChecked(batchViews, '3')}> 学生</label>
                </div>
            </div>
            <div class="hzau-section">
                <button id="hzau-btn-history" style="width:100%; padding:8px; border:1px solid #1890ff; color:#1890ff; background:white; border-radius:4px; cursor:pointer;">查看下载历史记录</button>
            </div>
        `;

        body.querySelector('#hzau-btn-history').addEventListener('click', () => {
            let histories = [];
            try { histories = JSON.parse(GM_getValue('hzau_history', '[]')); } catch(e){}
            
            const { modal: histModal, body: histBody, footer: histFooter, close: histClose } = createModal('下载历史 (最近50条)');
            if (histories.length === 0) {
                histBody.innerHTML = '<div style="padding:20px; text-align:center; color:#999;">暂无历史记录</div>';
            } else {
                histBody.innerHTML = '<div style="max-height:300px; overflow-y:auto; font-size:12px;">' + histories.map(h => `
                    <div style="border-bottom:1px solid #eee; padding:8px 0;">
                        <div style="font-weight:bold; color:#333;">${h.courseName} - ${h.resourceName}</div>
                        <div style="color:#666; margin-top:4px;">任务数: ${h.totalTasks} (成功: ${h.successCount}) | 耗时: ${formatTime(h.totalSeconds)}</div>
                        <div style="color:#999; margin-top:2px;">时间: ${new Date(h.date).toLocaleString()}</div>
                    </div>
                `).join('') + '</div>';
            }
            const closeBtn = document.createElement('button');
            closeBtn.className = 'hzau-download-btn';
            closeBtn.textContent = '关闭';
            closeBtn.addEventListener('click', histClose);
            histFooter.appendChild(closeBtn);
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'hzau-download-btn';
        cancelBtn.style.background = '#f0f0f0';
        cancelBtn.style.color = '#666';
        cancelBtn.textContent = '取消';
        cancelBtn.addEventListener('click', close);

        const saveBtn = document.createElement('button');
        saveBtn.className = 'hzau-download-btn';
        saveBtn.textContent = '保存设置';
        saveBtn.addEventListener('click', () => {
            const getChecked = (selector) => Array.from(body.querySelectorAll(selector + ' input:checked')).map(cb => cb.value);
            
            setConfig('concurrencyLimit', parseInt(body.querySelector('#hzau-cfg-concurrency').value) || 3);
            setConfig('downloadRoot', body.querySelector('#hzau-cfg-root').value || '课堂录播/');
            setConfig('singleDefaultViews', getChecked('#hzau-cfg-single'));
            setConfig('batchDefaultViews', getChecked('#hzau-cfg-batch'));
            
            close();
        });

        footer.appendChild(cancelBtn);
        footer.appendChild(saveBtn);
    }

    function createGlobalSettingsBtn() {
        if (document.querySelector('.hzau-settings-float')) return;
        const floatBtn = document.createElement('div');
        floatBtn.className = 'hzau-float-btn hzau-settings-float';
        floatBtn.textContent = '⚙设置';
        floatBtn.style.top = '65%';
        floatBtn.style.background = '#722ed1';
        floatBtn.addEventListener('click', showSettingsModal);
        
        // Add hover effect style dynamically
        floatBtn.addEventListener('mouseenter', () => floatBtn.style.background = '#9254de');
        floatBtn.addEventListener('mouseleave', () => floatBtn.style.background = '#722ed1');
        
        document.body.appendChild(floatBtn);
        makeDraggable(floatBtn);
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
        makeDraggable(floatBtn);
    }

    function showVideoDownloadModal(videoList, resourceName, courseName) {
        const { modal, body, footer, close } = createModal('下载录播视频');

        // 视角选择
        const viewSection = document.createElement('div');
        viewSection.className = 'hzau-section';
        const defaultViews = getConfig('singleDefaultViews') || [];
        viewSection.innerHTML = `
            <div class="hzau-section-title">选择下载视角（可多选）</div>
            <div class="hzau-checkbox-group">
                ${videoList.map(video => `
                    <label class="hzau-checkbox-item">
                        <input type="checkbox" value="${video.videoCode}" ${defaultViews.includes(video.videoCode) ? 'checked' : ''}>
                        ${video.videoName}（${formatSize(video.videoSize)}）
                    </label>
                `).join('')}
            </div>
        `;
        body.appendChild(viewSection);

        // 视频信息
        const infoSection = document.createElement('div');
        infoSection.className = 'hzau-section';
        const root = getConfig('downloadRoot');
        infoSection.innerHTML = `
            <div class="hzau-section-title">视频信息</div>
            <div style="font-size: 13px; color: #666; line-height: 1.8;">
                <div>视频名称：${resourceName}</div>
                <div>课程名称：${courseName}</div>
                <div>下载路径：${root}${getSafeFileName(courseName, 50)}/</div>
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

        const limit = getConfig('concurrencyLimit');
        const globalTracker = new GlobalProgressTracker(selectedVideos.length, limit);
        const totalBytes = selectedVideos.reduce((sum, v) => sum + parseSizeToBytes(v.videoSize), 0);
        globalTracker.addDiscoveredResourceBytes(totalBytes);

        const root = getConfig('downloadRoot');

        const tasks = selectedVideos.map((video, index) => {
            const taskId = `v_${index}`;
            const viewName = VIEW_MAP[video.videoCode] || video.videoName;
            const itemName = `${video.videoName}`;
            const item = addDownloadItem(panel, itemName);

            return async () => {
                try {
                    updateDownloadItem(item, '下载中... 0%');
                    globalTracker.updateTask(taskId, 'running');

                    const safeCourse = getSafeFileName(courseName, 50);
                    const safeRes = getSafeFileName(resourceName, 80);
                    const safeView = getSafeFileName(viewName, 20);
                    const filePath = `${root}${safeCourse}/${safeRes}_${safeView}.mp4`;
                    console.log('[HZAU下载器] 下载到:', filePath);

                    await downloadFile(video.videoPath, filePath, (percent, speedStr, etaStr, rawDelta, speedNum, etaNum) => {
                        if (speedStr !== null) {
                            updateDownloadItem(item, `下载中... ${percent}% | ${speedStr} | 剩余 ${etaStr}`);
                        }
                        updateItemProgress(item, percent);
                        if (rawDelta > 0) {
                            globalTracker.updateTask(taskId, 'running', etaNum || 0, rawDelta);
                            updateProgress(panel, completed, selectedVideos.length, globalTracker.getStats());
                        }
                    });

                    updateDownloadItem(item, '下载完成', true);
                    successCount++;
                } catch (error) {
                    console.error('下载失败:', error);
                    updateDownloadItem(item, '下载失败', false, true);
                    failCount++;
                }

                completed++;
                globalTracker.updateTask(taskId, 'done');
                updateItemProgress(item, 0);
                updateProgress(panel, completed, selectedVideos.length, globalTracker.getStats());
            };
        });

        const globalStartTime = Date.now();
        await runTasksWithConcurrency(tasks, limit);
        const globalEndTime = Date.now();
        const totalSeconds = (globalEndTime - globalStartTime) / 1000;
        
        let timeHtml = `<div style="color: #666; margin-top: 4px; font-size: 12px;">总耗时：${formatTime(totalSeconds)}</div>`;

        // 添加总结
        const summary = document.createElement('div');
        summary.className = 'hzau-summary';
        summary.innerHTML = `
            <div style="margin-bottom: 4px;">下载完成！</div>
            <div style="color: #52c41a;">成功: ${successCount} 个</div>
            <div style="color: #ff4d4f;">失败: ${failCount} 个</div>
            ${timeHtml}
            <div style="color: #999; margin-top: 4px; font-size: 12px;">
                保存路径：${root}${getSafeFileName(courseName, 50)}/
            </div>
            <div style="color: #1890ff; margin-top: 8px; font-size: 12px; font-weight: bold;">面板将于 5 秒后自动关闭...</div>
        `;
        panel.querySelector('.video-list').appendChild(summary);
        panel.querySelector('h3').textContent = '下载完成';
        
        // 记录历史
        saveHistory({
            courseName,
            resourceName,
            totalTasks: selectedVideos.length,
            successCount,
            totalSeconds,
            date: Date.now()
        });

        // 5秒后自动关闭
        setTimeout(() => {
            if (document.body.contains(panel)) panel.remove();
        }, 5000);
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
        if (document.querySelector('.hzau-batch-download-btn') || document.querySelector('.hzau-batch-download-float')) return;

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
            makeDraggable(floatBtn);
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
        const defaultViews = getConfig('batchDefaultViews') || [];
        const isChecked = (code) => defaultViews.includes(code) ? 'checked' : '';
        viewSection.innerHTML = `
            <div class="hzau-section-title">选择下载视角（可多选）</div>
            <div class="hzau-checkbox-group">
                <label class="hzau-checkbox-item">
                    <input type="checkbox" value="1" ${isChecked('1')}>
                    教师机位
                </label>
                <label class="hzau-checkbox-item">
                    <input type="checkbox" value="2" ${isChecked('2')}>
                    板书机位
                </label>
                <label class="hzau-checkbox-item">
                    <input type="checkbox" value="3" ${isChecked('3')}>
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

        const pathInfo = document.createElement('div');
        pathInfo.style.cssText = 'font-size: 12px; color: #999; margin-top: 8px;';
        const root = getConfig('downloadRoot');
        pathInfo.textContent = `下载路径：${root}${getSafeFileName(courseName, 50)}/`;
        listSection.appendChild(pathInfo);

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
            const checkedViews = viewSection.querySelectorAll('input:checked');
            const selectedViewCodes = Array.from(checkedViews).map(cb => cb.value);

            if (selectedViewCodes.length === 0) {
                alert('请至少选择一个视角');
                return;
            }

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

        const limit = getConfig('concurrencyLimit');
        const globalTracker = new GlobalProgressTracker(totalTasks, limit);
        const tasks = [];

        for (let i = 0; i < selectedVideos.length; i++) {
            const video = selectedVideos[i];
            const resourceName = video.resourceName || `录播${i+1}`;
            const item = addDownloadItem(panel, resourceName);

            tasks.push(async () => {
                try {
                    updateDownloadItem(item, '获取视频地址...');

                    const videoInfo = await getVideoClassInfo(video.id);
                    const videoList = videoInfo.videoList || [];

                    const viewVideos = videoList.filter(v => selectedViewCodes.includes(v.videoCode));
                    let resourceBytes = 0;
                    for (const vv of viewVideos) {
                        resourceBytes += parseSizeToBytes(vv.videoSize);
                    }
                    globalTracker.addDiscoveredResourceBytes(resourceBytes);

                    if (viewVideos.length === 0) {
                        updateDownloadItem(item, '无可用视角', false, true);
                        failCount += selectedViewCodes.length;
                        completed += selectedViewCodes.length;
                        updateProgress(panel, completed, totalTasks, globalTracker.getStats());
                        return;
                    }

                    updateDownloadItem(item, `等待下载... (0/${viewVideos.length})`);

                    let viewSuccess = 0;
                    let viewFail = 0;

                    for (let j = 0; j < viewVideos.length; j++) {
                        const viewVideo = viewVideos[j];
                        const viewName = VIEW_MAP[viewVideo.videoCode] || viewVideo.videoName;
                        const taskId = `b_${i}_${j}`;

                        try {
                            const root = getConfig('downloadRoot');
                            const safeCourse = getSafeFileName(courseName, 50);
                            const safeRes = getSafeFileName(resourceName, 80);
                            const safeView = getSafeFileName(viewName, 20);
                            const filePath = `${root}${safeCourse}/${safeRes}_${safeView}.mp4`;
                            updateDownloadItem(item, `下载中... (${viewSuccess + viewFail + 1}/${viewVideos.length}) 0%`);
                            
                            globalTracker.updateTask(taskId, 'running');

                            await downloadFile(viewVideo.videoPath, filePath, (percent, speedStr, etaStr, rawDelta, speedNum, etaNum) => {
                                if (speedStr !== null) {
                                    updateDownloadItem(item, `下载中... (${viewSuccess + viewFail + 1}/${viewVideos.length}) ${percent}% | ${speedStr} | 剩余 ${etaStr}`);
                                }
                                updateItemProgress(item, percent);
                                if (rawDelta > 0) {
                                    globalTracker.updateTask(taskId, 'running', etaNum || 0, rawDelta);
                                    updateProgress(panel, completed, totalTasks, globalTracker.getStats());
                                }
                            });
                            
                            viewSuccess++;
                            successCount++;
                        } catch (error) {
                            console.error('下载失败:', error);
                            viewFail++;
                            failCount++;
                        }

                        globalTracker.updateTask(taskId, 'done');
                        completed++;
                        updateItemProgress(item, 0); // 重置进度条以便后续使用或消失
                        updateDownloadItem(item, `下载中... (${viewSuccess + viewFail}/${viewVideos.length})`);
                        updateProgress(panel, completed, totalTasks, globalTracker.getStats());
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
                    updateProgress(panel, completed, totalTasks, globalTracker.getStats());
                }
            });
        }

        const globalStartTime = Date.now();
        await runTasksWithConcurrency(tasks, limit);
        const globalEndTime = Date.now();
        const totalSeconds = (globalEndTime - globalStartTime) / 1000;

        let timeHtml = `<div style="color: #666; margin-top: 4px; font-size: 12px;">总耗时：${formatTime(totalSeconds)}</div>`;

        // 完成总结
        const summary = document.createElement('div');
        summary.className = 'hzau-summary';
        summary.innerHTML = `
            <div style="margin-bottom: 4px;">全部下载完成！</div>
            <div style="color: #52c41a;">成功: ${successCount} 个</div>
            <div style="color: #ff4d4f;">失败: ${failCount} 个</div>
            ${timeHtml}
            <div style="color: #999; margin-top: 4px; font-size: 12px;">
                保存路径：${getConfig('downloadRoot')}${getSafeFileName(courseName, 50)}/
            </div>
            <div style="color: #1890ff; margin-top: 8px; font-size: 12px; font-weight: bold;">面板将于 5 秒后自动关闭...</div>
        `;
        panel.querySelector('.video-list').appendChild(summary);
        panel.querySelector('h3').textContent = '批量下载完成';

        // 记录历史
        saveHistory({
            courseName,
            resourceName: '批量下载',
            totalTasks,
            successCount,
            totalSeconds,
            date: Date.now()
        });

        // 5秒后自动关闭
        setTimeout(() => {
            if (document.body.contains(panel)) panel.remove();
        }, 5000);
    }

    // 获取当前课程ID
    function getCurrentCourseId() {
        // 方法1：尝试从当前URL的hash中找 (最准确)
        const hash = window.location.hash;
        const match = hash.match(/courseId[=/:]([a-zA-Z0-9]+)/);
        if (match) {
            return match[1];
        }

        // 方法2：尝试从页面中的链接找
        const links = document.querySelectorAll('a[href*="courseId"]');
        for (const link of links) {
            const href = link.getAttribute('href');
            const m = href.match(/courseId[=/:]([a-zA-Z0-9]+)/);
            if (m) {
                return m[1];
            }
        }

        // 方法3：尝试从页面的全局变量中找 (可能存在单页跳转的旧缓存)
        if (window.__INITIAL_STATE__?.course?.id) {
            return window.__INITIAL_STATE__.course.id;
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
            const element = document.querySelector(selector);
            if (element) return resolve(element);

            const observer = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) {
                    observer.disconnect();
                    clearTimeout(timer);
                    resolve(el);
                }
            });

            observer.observe(document.body, { childList: true, subtree: true });

            const timer = setTimeout(() => {
                observer.disconnect();
                reject(new Error('等待元素超时: ' + selector));
            }, timeout);
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
                // 延迟执行，等待页面框架加载
                setTimeout(() => {
                    initVideoPage();
                    initCourseListPage();
                    createGlobalSettingsBtn();
                }, 1500);
            } else {
                // 课程列表页面
                initCourseListPage();
                createGlobalSettingsBtn();
            }
        }

        // 初始检测
        detectAndInit();

        // 监听hash变化与路由切换（单页应用）
        let detectTimer = null;
        function debouncedDetect() {
            if (detectTimer) clearTimeout(detectTimer);
            detectTimer = setTimeout(() => {
                console.log('[HZAU下载器] 页面变化，重新检测');
                detectAndInit();
            }, 500);
        }
        
        window.addEventListener('hashchange', debouncedDetect);
        
        // 代理 pushState 和 replaceState
        const originalPushState = history.pushState;
        history.pushState = function() {
            originalPushState.apply(this, arguments);
            debouncedDetect();
        };
        const originalReplaceState = history.replaceState;
        history.replaceState = function() {
            originalReplaceState.apply(this, arguments);
            debouncedDetect();
        };
    }

    // 启动
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
