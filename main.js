const express = require('express');
const multer = require('multer');
const path = require('path');
const util = require('util');
const childProcess = require('child_process');
const fs = require('fs');
const uuid = require('uuid');
const os = require('os'); // 引入 os 模块

const app = express();
const port = 8001;

// 设置 EJS 为模板引擎
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 配置 multer 用于处理文件上传
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/')
    },
    filename: function (req, file, cb) {
        cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname))
    }
});

const upload = multer({ storage: storage });

// 确保 uploads 目录存在
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

// 静态资源服务
app.use(express.static(path.join(__dirname, 'public')));

// 新增缓存目录配置
const cacheDir = path.join(__dirname, 'exr_cache');
if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir);
}

// 每天凌晨清理过期缓存
const cleanupInterval = setInterval(() => {
    const now = Date.now();
    fs.readdirSync(cacheDir).forEach(file => {
        const filePath = path.join(cacheDir, file);
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > 7 * 24 * 3600 * 1000) { // 保留7天
            fs.unlinkSync(filePath);
            console.log(`[Cache] Cleaned expired cache: ${file}`);
        }
    });
}, 24 * 3600 * 1000);

// body-parser 中间件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// GET /render 路由
app.get('/render', (req, res) => {
    res.render('render');
});

// POST /v1/upload (保持不变)
app.post('/v1/upload', upload.single('pbrtFile'), (req, res) => {
    const userId = req.body.userId;
    if (!userId) {
        return res.status(400).json({ error: 'Missing userId in request body' });
    }
    if (!req.file) {
        return res.status(400).json({ error: 'No pbrtFile uploaded' });
    }

    const taskId = uuid.v4();
    console.log(`[Upload] User ID: ${userId}, Task ID: ${taskId}, File: ${req.file.path}`);
    res.json({ taskId: taskId });
});

// GET /v1/status (保持不变)
app.get('/v1/status', (req, res) => {
    const taskId = req.query.id;
    const userId = req.query.userId;

    if (!taskId) {
        return res.status(400).json({ error: 'Missing task id' });
    }

    const randomStatus = Math.random();
    let status = 'pending';
    let imageUrl = null;
    let errorReason = null;

    if (randomStatus < 0.5) {
        status = 'pending';
    } else if (randomStatus < 0.7) {
        status = 'success';
        imageUrl = 'http://example.com/download/image.png';
    } else if (randomStatus < 0.8) {
        status = 'failed';
        errorReason = '后端超时';
    } else if (randomStatus < 0.9) {
        status = 'failed';
        errorReason = '场景文件语法错误';
    } else {
        status = 'not_found';
        errorReason = '任务不存在';
    }

    console.log(`[Status] Task ID: ${taskId}, User ID: ${userId || 'N/A'}, Status: ${status}`);

    if (status === 'success') {
        res.json({ status: 'success', imageUrl: imageUrl });
    } else if (status === 'failed') {
        res.status(500).json({ status: 'failed', error: errorReason });
    } else if (status === 'not_found') {
        res.status(404).json({ status: 'not_found', error: errorReason });
    } else {
        res.json({ status: 'pending' });
    }
});

// POST /v1/debug/render (修改 PBRT 调用和 EXR 预览图生成)
app.post('/v1/debug/render', upload.single('pbrtFile'), async (req, res) => {
    // 中间件设置响应头
    res.setHeader('Cache-Control', 'no-store');
    
    const currentHash = req.body.hash;
    const cachePath = path.join(cacheDir, `${currentHash}.exr`);
    
    // 检查缓存
    if (fs.existsSync(cachePath)) {
        console.log(`[Cache] Using cached EXR for hash ${currentHash}`);
        const stats = fs.statSync(cachePath);
        const exrData = fs.readFileSync(cachePath); // 读取原始二进制数据
        return res
            .setHeader('Content-Type', 'image/x-exr')
            .setHeader('Content-Length', stats.size)
            .setHeader('X-Cache', 'HIT')
            .send(exrData);
    }

    let pbrtFilePath = null;
    let pbrtContent = null;
    const exposure = parseFloat(req.body.exposure || 0); // 获取前端传递的曝光度，默认为 0

    if (req.file) {
        pbrtFilePath = req.file.path;
        console.log(`[Debug Render] File Upload: ${pbrtFilePath}`);
    } else if (req.body.pbrtContent) {
        // 使用在线编辑器内容
        pbrtContent = req.body.pbrtContent;
        const tempFilename = `temp-pbrt-${Date.now()}.pbrt`;
        pbrtFilePath = path.join(uploadsDir, tempFilename);
        fs.writeFileSync(pbrtFilePath, pbrtContent);
        console.log(`[Debug Render] Online Editor Content, saved to: ${pbrtFilePath}`);
    } else {
        return res.status(400).json({ error: 'No pbrtFile uploaded or pbrtContent provided' });
    }

    const pbrtCommand = 'pbrt';
    const nproc = os.cpus().length;
    const timestamp = Date.now();
    const outputExrName = `pbrt-${timestamp}.exr`; // 输出 EXR 文件名
    const outputExrPath = path.join('/tmp/pbrtapi', outputExrName); // EXR 输出到 /tmp

    // ++++ 添加输出目录创建逻辑 ++++
    const outputDir = path.dirname(outputExrPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const pbrtCommandArgs = [
        '--gpu',
        '--gpu-device', '0',
        '--nthreads', `${nproc}`,
        //'--log-level', 'verbose',
        '--outfile', outputExrPath, // 输出 EXR
        pbrtFilePath
    ];

    console.log(`[Debug Render] PBRT Command: ${pbrtCommand} ${pbrtCommandArgs.join(' ')}`);
    
    try {
        const execFile = util.promisify(childProcess.execFile);

        // 1. 执行 PBRT 渲染，输出 EXR
        const pbrtResult = await execFile(pbrtCommand, pbrtCommandArgs, { timeout: 60000 });
        if (pbrtResult.stderr) {
            console.error(`PBRT stderr:\n${pbrtResult.stderr}`);
        }
        console.log(`PBRT stdout:\n${pbrtResult.stdout}`);

        if (fs.existsSync(outputExrPath)) {
            // 读取EXR文件并转换为base64
            const exrData = fs.readFileSync(outputExrPath);
            const base64Data = exrData.toString('base64');
            // 保存到缓存
            fs.writeFileSync(cachePath, exrData);

            res.json({
                status: 'success',
                exrData: base64Data,
                message: '渲染成功'
            });
        } else {
            console.warn(`Warning: outputExrPath does not exists when trying to render: ${outputExrPath}`);
            // 增加容错返回
            return res.status(500).json({
                status: 'error',
                error: `渲染失败，输出文件 ${outputExrPath} 不存在`,
            });
        }
    } catch (error) {
        console.error(`PBRT execution error:\n${error}`);
        let errorMessage = 'PBRT rendering failed';
        if (error.stderr) {
            errorMessage += `\nStderr: ${error.stderr}`;
        } else if (error.stdout) {
            errorMessage += `\nStdout: ${error.stdout}`;
        } else if (error.message) {
            errorMessage += `\nError Message: ${error.message}`;
        }
        res.status(500).json({ 
            status: 'error', 
            error: String(errorMessage) 
        }).header('Content-Type', 'application/json; charset=utf-8');
    } finally {
        // 保存到缓存
        if (fs.existsSync(outputExrPath)) {
            fs.copyFileSync(outputExrPath, cachePath);
            console.log(`[Cache] Saved new cache for ${currentHash}`);
        }
        // 清理过程
        if (req.body.lastHash && req.body.lastHash !== currentHash) {
            const oldCachePath = path.join(cacheDir, `${req.body.lastHash}.exr`);
            if (fs.existsSync(oldCachePath)) {
                fs.unlinkSync(oldCachePath);
                console.log(`[Cache] Cleaned previous cache ${req.body.lastHash}`);
            }
        }
        // 清理临时 .pbrt 文件
        if (pbrtFilePath && fs.existsSync(pbrtFilePath)) {
            fs.unlink(pbrtFilePath, (err) => {
                if (err && err.code !== 'ENOENT') {
                    console.warn(`Warning: Could not delete temporary file ${pbrtFilePath}: ${err}`);
                }
            });
        }
    }
});

// 添加限流中间件防止滥用
app.use('/v1/debug/render', (req, res, next) => {
    const MAX_SIZE = 150 * 1024 * 1024; // 150MB
    if (req.headers['content-length'] > MAX_SIZE) {
        return res.status(413).json({ error: '文件大小超过限制' });
    }
    next();
});

// GET /v1/list (保持不变)
app.get('/v1/list', (req, res) => {
    const userId = req.query.userId;
    if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
    }
    console.log(`[List] User ID: ${userId}`);
    res.json([]);
});

app.get('/', (req, res) => {
    res.send('PBRT API is running');
});

app.listen(port, () => {
    console.log(`PBRT API listening at http://localhost:${port}`);
});
