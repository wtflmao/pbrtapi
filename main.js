const express = require('express');
const multer = require('multer');
const path = require('path');
const util = require('util');
const childProcess = require('child_process');
const fs = require('fs');
const uuid = require('uuid');
const os = require('os'); // 引入 os 模块
const AdmZip = require('adm-zip');
const unrar = require('unrar-promise');
// 引入Swagger相关模块
const swaggerUi = require('swagger-ui-express');
const swaggerFile = require('./swagger_output.json');

// 引入配置文件
const settings = require('./settings.json');

// 辅助函数：转义正则表达式中的特殊字符
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& 表示匹配到的子串
}

const app = express();
const port = 8001;

// 设置全局未捕获异常处理，防止程序崩溃退出
process.on('uncaughtException', (err) => {
    console.error('未捕获的异常，但服务不会退出:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('未处理的Promise拒绝，但服务不会退出:', reason);
});

// 创建一个包装器函数，用于包装异步路由处理函数，确保错误被捕获并传递给Express错误处理中间件
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// 设置请求大小限制为1GB
app.use(express.json({limit: '1gb'}));
app.use(express.urlencoded({ extended: true, limit: '1gb' }));

// 配置Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerFile));

// 配置静态文件服务，将 public 目录设置为静态资源根目录
app.use(express.static(path.join(__dirname, 'public')));

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

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 1024 * 1024 * 1024 // 1GB
    }
});

// 确保 uploads 目录存在
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

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

// 模型存储相关配置
const MODELS_DIR = '/home/pog/pbrtapi/uploads/models';
if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
}

// 配置模型文件上传
const modelStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        // 尝试从请求体中获取info中的UUID
        let modelUuid;
        try {
            const info = JSON.parse(req.body.info || '{}');
            modelUuid = info.uuid;
        } catch (e) {
            modelUuid = null;
        }
        
        // 如果没有提供UUID，则生成新的
        if (!modelUuid) {
            modelUuid = uuid.v4();
        }
        
        const modelDir = path.join(MODELS_DIR, modelUuid);
        
        // 如果目录已存在，生成新的UUID
        if (fs.existsSync(modelDir)) {
            modelUuid = uuid.v4();
            const newModelDir = path.join(MODELS_DIR, modelUuid);
            fs.mkdirSync(newModelDir);
            // 将生成的新UUID保存到请求对象中
            req.generatedModelUuid = modelUuid;
        } else {
            fs.mkdirSync(modelDir);
        }
        
        cb(null, path.join(MODELS_DIR, modelUuid));
    },
    filename: function (req, file, cb) {
        // 对于zip文件使用临时名称，其他文件保持原始文件名
        if (path.extname(file.originalname).toLowerCase() === '.zip') {
            cb(null, 'upload.zip');
        } else {
            cb(null, file.originalname);
        }
    }
});

const uploadModel = multer({ 
    storage: modelStorage,
    limits: {
        fileSize: 1024 * 1024 * 1024 // 1GB
    },
    fileFilter: function (req, file, cb) {
        // 使用配置文件中的支持的文件类型
        const ext = path.extname(file.originalname).toLowerCase();
        if (settings.supportedModelExtensions.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error(`不支持的文件类型，支持的文件类型有 ${settings.supportedModelExtensions.join(', ')}`));
        }
    }
});

/**
 * @route GET /
 * @description 检查 API 服务是否正在运行
 * @returns {string} 返回服务运行状态消息
 */
app.get('/', (req, res) => {
    // #swagger.tags = ['系统状态']
    // #swagger.description = '检查API服务是否正在运行'
    // #swagger.responses[200] = { description: 'API服务正在运行' }
    res.send('PBRT API is running');
});

/**
 * @route GET /render
 * @description 渲染页面路由，返回渲染视图
 * @returns {void} 渲染 render 视图
 */
app.get('/render', (req, res) => {
    // #swagger.tags = ['渲染相关']
    // #swagger.description = '返回渲染页面视图'
    // #swagger.responses[200] = { description: '成功返回渲染页面' }
    res.render('render');
});

/**
 * @route POST /v1/upload
 * @description 上传 PBRT 文件
 * @param {string} userId - 用户唯一标识
 * @param {file} pbrtFile - 要上传的 PBRT 文件
 * @returns {Object} 包含任务ID的响应
 * @throws {400} 如果缺少用户ID或文件
 */
app.post('/v1/upload', upload.single('pbrtFile'), (req, res) => {
    // #swagger.tags = ['渲染相关']
    // #swagger.description = '上传PBRT文件进行渲染'
    /* #swagger.consumes = ['multipart/form-data']
       #swagger.parameters['pbrtFile'] = {
            in: 'formData',
            type: 'file',
            required: 'true',
            description: '要上传的PBRT文件'
        }
    */
    /* #swagger.responses[200] = {
            description: '上传成功',
            schema: {
                uuid: '任务标识UUID',
                filename: '上传的文件名',
                status: '任务状态'
            }
        }
    */
    // #swagger.responses[400] = { description: '请求错误' }
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

/**
 * @route GET /v1/status
 * @description 获取渲染任务状态
 * @query {string} id - 任务ID
 * @query {string} [userId] - 可选的用户ID
 * @returns {Object} 任务状态信息
 * - 状态可能为: 'pending', 'success', 'failed', 'not_found'
 * @throws {400} 如果缺少任务ID
 */
app.get('/v1/status', (req, res) => {
    // #swagger.tags = ['渲染相关']
    // #swagger.description = '获取渲染任务状态'
    /* #swagger.parameters['uuid'] = {
            in: 'query',
            description: '任务的UUID',
            required: true,
            type: 'string'
        }
    */
    /* #swagger.responses[200] = {
            description: '成功获取状态',
            schema: {
                uuid: '任务UUID',
                status: '任务状态',
                progress: '渲染进度百分比',
                imageData: '渲染图像的base64编码(如果已完成)'
            }
        }
    */
    // #swagger.responses[404] = { description: '任务不存在' }
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

/**
 * @route POST /v1/debug/render
 * @description 调试渲染，支持文件上传和在线内容渲染
 * @param {file} [pbrtFile] - 可选的 PBRT 文件上传
 * @param {string} [pbrtContent] - 可选的在线编辑器内容
 * @param {string} hash - 用于缓存的哈希值
 * @param {number} [exposure=0] - 可选的曝光度设置
 * @returns {Buffer} EXR 格式的渲染图像
 * @throws {400} 如果没有提供 PBRT 文件或内容
 * @throws {500} 渲染失败时
 */
app.post('/v1/debug/render', upload.single('pbrtFile'), asyncHandler(async (req, res) => {
    // #swagger.tags = ['渲染相关']
    // #swagger.description = '上传PBRT文件用于调试渲染'
    /* #swagger.consumes = ['multipart/form-data']
       #swagger.parameters['pbrtFile'] = {
            in: 'formData',
            type: 'file',
            required: 'true',
            description: '要上传的PBRT文件'
        }
    */
    /* #swagger.responses[200] = {
            description: '调试渲染成功',
            schema: {
                uuid: '任务标识UUID',
                result: '渲染结果信息'
            }
        }
    */
    // #swagger.responses[400] = { description: '请求错误' }
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
        
        // 安全检查：检测文件内容是否包含目录遍历攻击
        try {
            const fileContent = fs.readFileSync(pbrtFilePath, 'utf8');
            
            // 检查安全风险
            if (hasSuspiciousPbrtPaths(fileContent)) {
                console.error(`[Security] 检测到可能的目录遍历尝试，拒绝处理文件: ${pbrtFilePath}`);
                fs.unlinkSync(pbrtFilePath); // 立即删除可疑文件
                return res.status(403).json({ error: '检测到可能的安全问题，拒绝处理文件' });
            }
            
            // 始终使用相对路径模式进行路径规范化
            const sanitizedContent = sanitizePbrtPaths(fileContent, path.dirname(pbrtFilePath), true);
            
            // 如果内容被修改，写回文件
            if (sanitizedContent !== fileContent) {
                fs.writeFileSync(pbrtFilePath, sanitizedContent, 'utf8');
                console.log(`[Security] 已规范化PBRT文件中的路径引用为相对路径`);
            }

            // 添加额外的模型路径纹理检查，确保使用相对路径
            let moreChecks = false;
            let updatedContent = sanitizedContent;
            
            // 特殊处理models/{uuid}/textures/*N格式
            const modelTexPattern = /models\/([a-f0-9-]+)\/textures\/\*(\d+)/g;
            let modelTexMatch;
            while ((modelTexMatch = modelTexPattern.exec(sanitizedContent)) !== null) {
                moreChecks = true;
                const modelId = modelTexMatch[1];
                const textureIndex = modelTexMatch[2];
                console.log(`[Debug Render] 检测到模型纹理引用: models/${modelId}/textures/*${textureIndex}`);
                
                // 验证该模型目录是否存在
                const modelTexDir = path.join(MODELS_DIR, modelId, 'textures');
                if (fs.existsSync(modelTexDir)) {
                    console.log(`[Debug Render] 模型纹理目录存在: ${modelTexDir}`);
                } else {
                    console.warn(`[Debug Render] 警告: 模型纹理目录不存在: ${modelTexDir}`);
                }
            }
            
            // 检查并修复PBRT直接引用纹理的 /home/pog/pbrtapi/ 绝对路径
            const absoluteTexPattern = /"string filename"\s+"\/home\/pog\/pbrtapi\/uploads\/([^"]+)"/g;
            let absTexMatch;
            while ((absTexMatch = absoluteTexPattern.exec(sanitizedContent)) !== null) {
                moreChecks = true;
                const absPath = absTexMatch[0];
                const texPath = absTexMatch[1];
                console.log(`[Debug Render] 发现绝对路径纹理引用，转换为相对路径: ${texPath}`);
                
                // 替换为相对路径
                updatedContent = updatedContent.replace(
                    absPath,
                    `"string filename" "${texPath}"`
                );
            }
            
            // 如果有更多修改，重新写入文件
            if (moreChecks && updatedContent !== sanitizedContent) {
                fs.writeFileSync(pbrtFilePath, updatedContent, 'utf8');
                console.log(`[Debug Render] 已进一步修复PBRT文件中的纹理路径引用`);
            }
        } catch (err) {
            console.error(`[Security] 文件安全检查失败: ${err.message}`);
        }
    } else if (req.body.pbrtContent) {
        // 使用在线编辑器内容
        pbrtContent = req.body.pbrtContent;
        
        // 安全检查：检测编辑器内容是否包含目录遍历攻击
        if (hasSuspiciousPbrtPaths(pbrtContent)) {
            console.error(`[Security] 检测到在线编辑器内容中可能的目录遍历尝试`);
            return res.status(403).json({ error: '检测到可能的安全问题，拒绝处理内容' });
        }
        
        const tempFilename = `temp-pbrt-${Date.now()}.pbrt`;
        pbrtFilePath = path.join(uploadsDir, tempFilename);
        
        // 创建临时目录用于存放纹理文件
        const tempDir = path.join(uploadsDir, `temp-textures-${Date.now()}`);
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        // 始终使用相对路径模式
        const sanitizedContent = sanitizePbrtPaths(pbrtContent, tempDir, true);
        fs.writeFileSync(pbrtFilePath, sanitizedContent);
        console.log(`[Debug Render] 使用相对路径保存在线编辑器内容: ${pbrtFilePath}`);
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

    // 确保pbrtFilePath是绝对路径
    const absolutePbrtFilePath = path.isAbsolute(pbrtFilePath) ? 
        pbrtFilePath : path.resolve(process.cwd(), pbrtFilePath);
    console.log(`[Debug Render] 使用绝对路径执行PBRT: ${absolutePbrtFilePath}`);
    
    const pbrtCommandArgs = [
        '--gpu',
        '--gpu-device', '0',
        '--nthreads', `${nproc}`,
        '--log-level', 'verbose',
        '--outfile', outputExrPath, // 输出 EXR
        absolutePbrtFilePath // 使用绝对路径
    ];

    console.log(`[Debug Render] PBRT Command: ${pbrtCommand} ${pbrtCommandArgs.join(' ')}`);
    
    try {
        const execFile = util.promisify(childProcess.execFile);

        // 1. 尝试扫描并修复PBRT文件中的纹理路径问题
        try {
            console.log(`[Debug Render] 扫描并修复PBRT文件中的纹理路径问题`);
            let pbrtContent = fs.readFileSync(absolutePbrtFilePath, 'utf8');
            
            // 提取模型UUID引用的正则表达式
            const modelUuidRegex = /\/home\/pog\/pbrtapi\/uploads\/models\/([a-f0-9-]+)\/textures\/\*(\d+)/g;
            let match;
            const modelTextures = new Map(); // 存储模型ID及其纹理文件列表
            
            // 收集所有引用的模型ID和纹理索引
            while ((match = modelUuidRegex.exec(pbrtContent)) !== null) {
                const [fullPath, modelId, textureIndex] = match;
                if (!modelTextures.has(modelId)) {
                    // 读取模型的textures目录
                    const texturesDir = path.join(MODELS_DIR, modelId, 'textures');
                    if (fs.existsSync(texturesDir)) {
                        try {
                            const files = fs.readdirSync(texturesDir);
                            modelTextures.set(modelId, files);
                            console.log(`[Debug Render] 模型 ${modelId} 的纹理文件: ${files.join(', ')}`);
                        } catch (err) {
                            console.error(`[Debug Render] 无法读取模型 ${modelId} 的纹理目录: ${err.message}`);
                        }
                    } else {
                        console.warn(`[Debug Render] 警告: 模型 ${modelId} 的纹理目录不存在: ${texturesDir}`);
                        modelTextures.set(modelId, []);
                    }
                }
            }
            
            // 使用相对路径替代绝对路径模式，这样即使找不到确切文件名也能保证路径格式正确
            const fixedContent = pbrtContent.replace(
                /\/home\/pog\/pbrtapi\/uploads\/models\/([a-f0-9-]+)\/textures\/\*(\d+)/g,
                (match, modelId, textureIndex) => {
                    // 直接使用相对路径+通配符，在回到上传目录之前这是最安全的方案
                    return `models/${modelId}/textures/*${textureIndex}`;
                }
            );
            
            if (fixedContent !== pbrtContent) {
                fs.writeFileSync(absolutePbrtFilePath, fixedContent);
                console.log(`[Debug Render] 已修复PBRT文件中的纹理路径为相对路径`);
                pbrtContent = fixedContent;
            }
            
            // 新增: 尝试替换占位符为实际纹理文件名
            modelTextures.forEach((textureFiles, modelId) => {
                if (textureFiles.length > 0) {
                    const modelDir = path.join(MODELS_DIR, modelId);
                    const processedContent = replaceTextureReferences(pbrtContent, modelDir, modelId);
                    if (processedContent !== pbrtContent) {
                        fs.writeFileSync(absolutePbrtFilePath, processedContent);
                        console.log(`[Debug Render] 成功替换PBRT文件中模型 ${modelId} 的纹理占位符为实际文件名`);
                        pbrtContent = processedContent;
                    }
                }
            });
        } catch (err) {
            console.error(`[Debug Render] 修复纹理路径失败: ${err.message}`);
        }
        
        // 2. 执行PBRT渲染，从上传目录启动以便找到相对路径引用的纹理
        console.log(`[Debug Render] 从上传目录启动PBRT以支持相对路径引用`);
        const pbrtResult = await execFile(pbrtCommand, pbrtCommandArgs, { 
            timeout: 60000,
            cwd: uploadsDir // 关键修改: 从上传目录运行pbrt，这样可以找到相对路径中的models目录
        });
        
        if (pbrtResult.stderr) {
            console.error(`PBRT stderr:\n${pbrtResult.stderr}`);
        }
        console.log(`PBRT stdout:\n${pbrtResult.stdout}`);

        if (fs.existsSync(outputExrPath)) {
            // 读取EXR文件并转换为base64
            const exrData = fs.readFileSync(outputExrPath);
            // 保存到缓存
            fs.writeFileSync(cachePath, exrData);

            res.setHeader('Content-Type', 'image/x-exr')
                .setHeader('Content-Length', exrData.length)
                .setHeader('X-Cache', 'MISS')
                .send(exrData);
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
        
        // 修复错误：先设置header，再发送响应
        return res
            .status(500)
            .setHeader('Content-Type', 'application/json; charset=utf-8')
            .json({ 
                status: 'error', 
                error: String(errorMessage) 
            });
    } finally {
        // 确保在异常情况下代码不会崩溃
        try {
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
        } catch (cleanupError) {
            console.error(`清理过程出错但不影响主流程: ${cleanupError.message}`);
        }
    }
}));

// 添加限流中间件防止滥用
app.use('/v1/debug/render', (req, res, next) => {
    const MAX_SIZE = 150 * 1024 * 1024; // 150MB
    if (req.headers['content-length'] > MAX_SIZE) {
        return res.status(413).json({ error: '文件大小超过限制' });
    }
    next();
});

/**
 * @route GET /v1/list
 * @description 获取所有渲染任务列表
 * @returns {Array} 任务列表
 */
app.get('/v1/list', (req, res) => {
    // #swagger.tags = ['系统状态']
    // #swagger.description = '获取所有渲染任务列表'
    /* #swagger.responses[200] = {
            description: '成功获取任务列表',
            schema: {
                tasks: [
                    {
                        uuid: '任务UUID',
                        filename: '文件名',
                        status: '任务状态',
                        timestamp: '创建时间'
                    }
                ]
            }
        }
    */
    const userId = req.query.userId;
    if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
    }
    console.log(`[List] User ID: ${userId}`);
    res.json([]);
});

/**
 * @route GET /v1/model
 * @description 获取所有模型列表
 * @returns {Array} 模型列表
 */
app.get('/v1/model', (req, res) => {
    // #swagger.tags = ['模型相关']
    // #swagger.description = '获取所有模型列表'
    /* #swagger.responses[200] = {
            description: '成功获取模型列表',
            schema: {
                models: [
                    {
                        uuid: '模型UUID',
                        name: '模型名称',
                        path: '模型路径',
                        thumbnail: '缩略图URL',
                        createdAt: '创建时间'
                    }
                ]
            }
        }
    */
    try {
        const models = [];
        const dirs = fs.readdirSync(MODELS_DIR);
        
        for (const dir of dirs) {
            const infoPath = path.join(MODELS_DIR, dir, 'info.json');
            if (fs.existsSync(infoPath)) {
                const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
                models.push(info);
            }
        }
        
        res.json(models);
    } catch (error) {
        console.error('获取模型列表失败:', error);
        res.status(500).json({ error: '获取模型列表失败' });
    }
});

// 验证模型文件是否存在
function validateModelPath(modelDir, modelPath) {
    const absolutePath = path.join(modelDir, modelPath);
    // 检查路径是否试图访问父目录
    if (!absolutePath.startsWith(modelDir)) {
        throw new Error('无效的模型路径');
    }
    if (!fs.existsSync(absolutePath)) {
        throw new Error('模型文件不存在');
    }
    return true;
}

// 修改 cleanupFiles 函数来修复目录清理的 bug
function cleanupFiles(dir, relativePath = '') {
    const files = fs.readdirSync(dir);
    let hasValidContent = false; // 用于跟踪目录是否包含有效内容

    for (const file of files) {
        const fullPath = path.join(dir, file);
        const relPath = path.join(relativePath, file);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            // 如果是 texture 目录，标记为有效内容并跳过
            if (file.toLowerCase() === 'texture' || file.toLowerCase() === 'textures') {
                hasValidContent = true;
                continue;
            }
            // 递归处理子目录，并获取子目录的处理结果
            const subDirHasContent = cleanupFiles(fullPath, relPath);
            // 如果子目录有有效内容，当前目录也标记为有有效内容
            if (subDirHasContent) {
                hasValidContent = true;
            } else {
                // 如果子目录没有有效内容，删除它
                fs.rmdirSync(fullPath);
            }
        } else {
            // 检查文件扩展名
            const ext = path.extname(file).toLowerCase();
            if (settings.keepFileExtensions.includes(ext)) {
                hasValidContent = true;
            } else {
                fs.unlinkSync(fullPath);
            }
        }
    }

    return hasValidContent;
}

/**
 * @route POST /v1/model
 * @description 上传新的3D模型文件
 * @param {file} model - 要上传的3D模型文件
 * @param {string} info - 模型信息JSON字符串
 * @returns {object} 上传结果信息
 */
app.post('/v1/model', uploadModel.single('model'), asyncHandler(async (req, res) => {
    // #swagger.tags = ['模型相关']
    // #swagger.description = '上传新的3D模型文件'
    /* #swagger.consumes = ['multipart/form-data']
       #swagger.parameters['model'] = {
            in: 'formData',
            type: 'file',
            required: 'true',
            description: '要上传的3D模型文件'
        }
       #swagger.parameters['info'] = {
            in: 'formData',
            type: 'string',
            required: 'false',
            description: '模型信息JSON字符串'
        }
    */
    /* #swagger.responses[200] = {
            description: '上传成功',
            schema: {
                uuid: '模型UUID',
                path: '模型路径',
                success: true
            }
        }
    */
    // #swagger.responses[400] = { description: '请求错误' }
    const modelDir = req.file ? path.dirname(req.file.path) : null;
    let needCleanup = true;

    try {
        if (!req.file) {
            throw new Error('未提供模型文件');
        }

        const fileExt = path.extname(req.file.originalname).toLowerCase();
        let modelInfo;

        if (fileExt === '.zip' || fileExt === '.rar') {
            // 处理压缩文件
            try {
                if (fileExt === '.zip') {
                    // 处理 ZIP 文件
                    const zip = new AdmZip(req.file.path);
                    zip.extractAllTo(modelDir, true);
                } else {
                    // 处理 RAR 文件
                    await unrar.extract(req.file.path, modelDir);
                }
                
                // 删除压缩文件
                fs.unlinkSync(req.file.path);

                // 首先尝试使用网页编辑器提供的info.json
                try {
                    modelInfo = JSON.parse(req.body.info || '{}');
                } catch (e) {
                    modelInfo = {};
                }

                // 如果压缩包中有info.json，则与网页编辑器的info.json合并
                const infoPath = path.join(modelDir, 'info.json');
                if (fs.existsSync(infoPath)) {
                    try {
                        const zipInfo = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
                        
                        // 修改合并逻辑：只有用户修改过的字段才会覆盖压缩包中的值
                        // 首先判断是否传入了原始默认info的字段标记
                        const defaultInfoFields = req.body.defaultInfoFields ? 
                            JSON.parse(req.body.defaultInfoFields) : [];
                            
                        if (defaultInfoFields.length > 0) {
                            // 如果有标记默认字段，则只合并非默认字段的值
                            const mergedInfo = { ...zipInfo };
                            
                            for (const key in modelInfo) {
                                // 如果这个字段不在默认字段列表中，说明用户修改过，才覆盖
                                if (!defaultInfoFields.includes(key)) {
                                    mergedInfo[key] = modelInfo[key];
                                }
                            }
                            
                            modelInfo = mergedInfo;
                            console.log('合并info.json: 用户修改的字段已覆盖压缩包中的值');
                        } else {
                            // 如果没有标记默认字段（兼容旧版本），使用旧的合并逻辑
                            // 但反转优先级，让压缩包中的值优先
                            modelInfo = { ...modelInfo, ...zipInfo };
                            console.log('合并info.json: 使用旧逻辑，压缩包中的值优先');
                        }
                    } catch (e) {
                        console.warn('压缩包中的info.json格式无效，将忽略:', e.message);
                    }
                }

                // 递归查找模型文件
                const modelFiles = findModelFilesRecursively(modelDir);
                
                // 清理无关文件
                cleanupFiles(modelDir);

                // 检查模型文件数量
                if (modelFiles.length === 1) {
                    // 找到唯一的模型文件
                    modelInfo.model_path = modelFiles[0];
                    const ext = path.extname(modelFiles[0]).substring(1).toUpperCase();
                    modelInfo.model_type = ext === 'GLB' ? 'GLTF' : ext;
                } else if (modelFiles.length > 1) {
                    throw new Error('压缩包中包含多个模型文件，请指定具体使用哪个文件');
                } else {
                    throw new Error('压缩包中未找到支持的模型文件');
                }

                // 使用目录名作为UUID
                const dirUuid = path.basename(modelDir);
                
                // 补充或更新必要字段
                modelInfo.uuid = dirUuid;
                modelInfo.name = modelInfo.name || path.basename(modelInfo.model_path, path.extname(modelInfo.model_path));
                modelInfo.type = modelInfo.type || 'unknown';
                modelInfo.model_type = modelInfo.model_type || 
                    (path.extname(modelInfo.model_path).substring(1).toUpperCase());
                modelInfo.upload_date = new Date().toISOString();

                // 验证模型文件是否存在
                validateModelPath(modelDir, modelInfo.model_path);

                // 如果是OBJ格式，检查MTL文件（如果在info中指定了）
                if (path.extname(modelInfo.model_path).toLowerCase() === '.obj' && modelInfo.mtl_path) {
                    validateModelPath(modelDir, modelInfo.mtl_path);
                }

            } catch (error) {
                throw new Error(`处理${fileExt === '.zip' ? 'ZIP' : 'RAR'}文件失败: ${error.message}`);
            }
        } else {
            // 处理单个模型文件
            try {
                modelInfo = JSON.parse(req.body.info || '{}');
            } catch (e) {
                modelInfo = {};
            }
            
            // 对 OBJ 文件增加特殊处理
            if (path.extname(req.file.originalname).toLowerCase() === '.obj') {
                // 检查同目录是否存在对应的 MTL 文件
                const objFileName = req.file.originalname;
                const mtlFileName = path.basename(objFileName, '.obj') + '.mtl';
                const mtlPath = path.join(modelDir, mtlFileName);
                
                if (!fs.existsSync(mtlPath)) {
                    // 删除已上传的文件
                    fs.unlinkSync(req.file.path);
                    
                    throw new Error('OBJ 文件必须与 MTL 文件一起打包上传。请将 OBJ 和 MTL 文件打包成 ZIP 压缩包后再上传。');
                }
            }
            
            // 使用目录名作为UUID
            const dirUuid = path.basename(modelDir);
            
            // 如果未提供info.json或提供的是空对象，则生成完整的info.json
            if (Object.keys(modelInfo).length === 0) {
                modelInfo = {
                    uuid: dirUuid,
                    name: path.basename(req.file.originalname, path.extname(req.file.originalname)),
                    model_path: req.file.filename,
                    type: 'unknown',
                    model_type: (path.extname(req.file.originalname).substring(1).toUpperCase()) === "GLB" ? "GLTF" : (path.extname(req.file.originalname).substring(1).toUpperCase()),
                    upload_date: new Date().toISOString()
                };
            } else {
                // 如果提供了部分info.json，确保必要字段存在
                modelInfo.uuid = dirUuid; // 始终使用目录名作为UUID
                modelInfo.name = modelInfo.name || path.basename(req.file.originalname, path.extname(req.file.originalname));
                modelInfo.model_path = req.file.filename;
                modelInfo.type = modelInfo.type ? (modelInfo.type === "GLB" ? "GLTF" : modelInfo.type) : 'unknown';
                modelInfo.model_type = modelInfo.model_type || path.extname(req.file.originalname).substring(1).toUpperCase();
                modelInfo.upload_date = new Date().toISOString();
            }

            // 验证模型文件是否存在
            validateModelPath(modelDir, modelInfo.model_path);

            // 如果是OBJ格式，检查MTL文件（如果在info中指定了）
            if (path.extname(modelInfo.model_path).toLowerCase() === '.obj' && modelInfo.mtl_path) {
                validateModelPath(modelDir, modelInfo.mtl_path);
            }
        }

        // 验证必需字段
        if (!modelInfo.name || !modelInfo.type || !modelInfo.model_type || !modelInfo.model_path) {
            throw new Error('缺少必需的模型信息（name, type, model_type, model_path）');
        }

        // 构建完整的模型信息
        const info = {
            uuid: modelInfo.uuid,
            name: modelInfo.name,
            type: modelInfo.type,
            model_type: modelInfo.model_type === "GLB" ? "GLTF" : modelInfo.model_type,
            model_path: modelInfo.model_path,
            ...modelInfo,
            upload_date: new Date().toISOString()
        };

        // 保存或更新模型信息
        fs.writeFileSync(
            path.join(modelDir, 'info.json'),
            JSON.stringify(info, null, 4),
            'utf8'
        );

        needCleanup = false;
        res.json(info);
        console.log(`[Model] Successfully uploaded model: ${info.name} (${info.uuid})`);
    } catch (error) {
        console.error('上传模型失败:', error);
        if (needCleanup && modelDir) {
            // 清理已上传的文件
            fs.rmSync(modelDir, { recursive: true, force: true });
        }
        res.status(500).json({ error: error.message || '上传模型失败' });
    }
}));

// 在模型上传处理中使用配置文件中的保留文件类型
function findModelFilesRecursively(dir, relativePath = '') {
    const files = fs.readdirSync(dir);
    const modelFiles = [];
    const allowedExts = settings.supportedModelExtensions.filter(ext => ext !== '.zip');

    for (const file of files) {
        const fullPath = path.join(dir, file);
        const relPath = path.join(relativePath, file);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            // 如果是目录，递归查找
            modelFiles.push(...findModelFilesRecursively(fullPath, relPath));
        } else if (allowedExts.includes(path.extname(file).toLowerCase())) {
            // 如果是模型文件，添加到列表
            modelFiles.push(relPath);
        }
    }

    return modelFiles;
}

/**
 * @route DELETE /v1/model/:uuid
 * @description 删除指定的模型
 * @param {string} uuid - 模型的UUID
 * @returns {object} 删除结果信息
 */
app.delete('/v1/model/:uuid', (req, res) => {
    // #swagger.tags = ['模型相关']
    // #swagger.description = '删除指定的模型'
    /* #swagger.parameters['uuid'] = {
            in: 'path',
            description: '模型的UUID',
            required: true,
            type: 'string'
        }
    */
    /* #swagger.responses[200] = {
            description: '删除成功',
            schema: {
                success: true,
                message: '删除成功'
            }
        }
    */
    // #swagger.responses[404] = { description: '模型不存在' }
    try {
        const modelId = req.params.uuid;
        const modelDir = path.join(MODELS_DIR, modelId);

        if (!fs.existsSync(modelDir)) {
            return res.status(404).json({ error: '模型不存在' });
        }

        // 删除模型目录及其所有内容
        fs.rmSync(modelDir, { recursive: true, force: true });
        res.json({ message: '模型删除成功' });
    } catch (error) {
        console.error('删除模型失败:', error);
        res.status(500).json({ error: '删除模型失败' });
    }
});

/**
 * @route GET /debug/models
 * @description 模型调试页面
 * @returns {void} 返回模型调试页面
 */
app.get('/debug/models', (req, res) => {
    // #swagger.tags = ['系统状态']
    // #swagger.description = '模型调试页面'
    // #swagger.responses[200] = { description: '成功返回模型调试页面' }
    res.render('debug-models');
});

/**
 * @route POST /v1/preview-zip
 * @description 预览ZIP/RAR文件中的info.json内容，不进行实际解压
 * @param {file} archive - 要预览的ZIP/RAR文件
 * @returns {Object} 包含info.json的内容
 * @throws {400} 如果未提供文件或文件类型不支持
 * @throws {500} 预览失败时
 */
app.post('/v1/preview-zip', upload.single('archive'), asyncHandler(async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '未提供文件' });
        }

        const fileExt = path.extname(req.file.originalname).toLowerCase();
        if (fileExt !== '.zip' && fileExt !== '.rar') {
            fs.unlinkSync(req.file.path); // 删除非zip/rar文件
            return res.status(400).json({ error: '仅支持ZIP或RAR格式' });
        }

        const tempDir = path.join(os.tmpdir(), 'pbrtapi-preview-' + uuid.v4());
        fs.mkdirSync(tempDir, { recursive: true });

        try {
            // 解压缩处理
            if (fileExt === '.zip') {
                const zip = new AdmZip(req.file.path);
                // 仅解压info.json文件
                zip.getEntries().forEach(entry => {
                    if (!entry.isDirectory && (entry.entryName.toLowerCase() === 'info.json' || entry.entryName.toLowerCase().endsWith('/info.json'))) {
                        console.log(`[Preview] 找到info.json: ${entry.entryName}`);
                        zip.extractEntryTo(entry, tempDir, false, true);
                    }
                });
            } else if (fileExt === '.rar') {
                // 对于RAR文件，提取info.json可能需要完整解压，然后只读取需要的文件
                await unrar.extract(req.file.path, tempDir);
            }

            // 递归搜索解压目录中的info.json
            const findInfoJsonFiles = (dir) => {
                let results = [];
                const files = fs.readdirSync(dir);
                for (const file of files) {
                    const fullPath = path.join(dir, file);
                    if (fs.statSync(fullPath).isDirectory()) {
                        results = results.concat(findInfoJsonFiles(fullPath));
                    } else if (file.toLowerCase() === 'info.json') {
                        results.push(fullPath);
                    }
                }
                return results;
            };

            const infoJsonFiles = findInfoJsonFiles(tempDir);

            // 如果找到了多个info.json，选择最上层的一个
            let infoJson = null;
            if (infoJsonFiles.length > 0) {
                // 按目录深度排序，选择最上层的
                infoJsonFiles.sort((a, b) => {
                    return a.split(path.sep).length - b.split(path.sep).length;
                });
                
                try {
                    const content = fs.readFileSync(infoJsonFiles[0], 'utf8');
                    infoJson = JSON.parse(content);
                    console.log(`[Preview] 成功读取info.json: ${infoJsonFiles[0]}`);
                } catch (e) {
                    console.warn(`[Preview] info.json解析失败: ${e.message}`);
                }
            }

            // 清理临时目录和上传文件
            fs.rmSync(tempDir, { recursive: true, force: true });
            fs.unlinkSync(req.file.path);

            // 返回找到的info.json内容，如果没找到则返回null
            res.json({ info: infoJson });
        } catch (error) {
            console.error(`[Preview] 预览失败: ${error.message}`);
            // 清理文件
            fs.unlinkSync(req.file.path);
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
            throw error;
        }
    } catch (error) {
        console.error(`[Preview] 处理失败: ${error.message}`);
        res.status(500).json({ error: error.message || '预览文件失败' });
    }
}));

/**
 * 检测无后缀名的图像文件类型并添加正确的后缀名
 * @param {string} texturesDir 纹理目录路径
 * @param {string} modelId 模型UUID
 * @returns {Array} 处理后的纹理文件列表
 */
function detectAndFixImageFileExtensions(texturesDir, modelId) {
    // 获取所有纹理文件
    const textureFiles = fs.readdirSync(texturesDir);
    if (textureFiles.length === 0) {
        return [];
    }
    
    console.log(`[Texture] 模型 ${modelId} 开始检测纹理文件类型，共 ${textureFiles.length} 个文件`);
    
    // 文件头签名映射
    const fileSignatures = {
        // PNG: 89 50 4E 47 0D 0A 1A 0A
        png: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        // JPEG: FF D8 FF
        jpeg: Buffer.from([0xFF, 0xD8, 0xFF]),
        // GIF87a: 47 49 46 38 37 61
        gif87a: Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]),
        // GIF89a: 47 49 46 38 39 61
        gif89a: Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
        // BMP: 42 4D
        bmp: Buffer.from([0x42, 0x4D]),
        // WEBP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50
        webp: Buffer.from([0x52, 0x49, 0x46, 0x46]),
        // TIFF (little-endian): 49 49 2A 00
        tiffLe: Buffer.from([0x49, 0x49, 0x2A, 0x00]),
        // TIFF (big-endian): 4D 4D 00 2A
        tiffBe: Buffer.from([0x4D, 0x4D, 0x00, 0x2A]),
    };
    
    const modifiedFiles = [...textureFiles];
    let modifiedCount = 0;
    
    // 使用Buffer.compare进行比较
    const compareBuffers = (buf1, buf2, start, length) => {
        return Buffer.compare(buf1.slice(start, start + length), buf2.slice(0, length)) === 0;
    };
    
    // 检查每个文件
    for (let i = 0; i < textureFiles.length; i++) {
        const file = textureFiles[i];
        const filePath = path.join(texturesDir, file);
        
        // 检查文件是否已有扩展名
        const fileExt = path.extname(file).toLowerCase();
        const fileNameWithoutExt = path.basename(file, fileExt);
        
        // 特殊处理：如果文件名只有一个点，或者点在末尾
        const specialCases = [
            fileExt === '.',  // 单独的点作为扩展名
            file.endsWith('.'),  // 点在文件名末尾
            fileNameWithoutExt === '',  // 文件名为空
        ];
        
        if (fileExt && !specialCases.some(Boolean)) {
            continue; // 已有有效扩展名，跳过
        }
        
        try {
            // 读取文件头
            const fd = fs.openSync(filePath, 'r');
            const buffer = Buffer.alloc(12); // 足够识别大多数图像格式
            fs.readSync(fd, buffer, 0, 12, 0);
            fs.closeSync(fd);
            
            // 检查文件头签名
            let detectedType = null;
            
            if (compareBuffers(buffer, fileSignatures.png, 0, 8)) {
                detectedType = 'png';
            } else if (compareBuffers(buffer, fileSignatures.jpeg, 0, 3)) {
                detectedType = 'jpg';
            } else if (compareBuffers(buffer, fileSignatures.gif87a, 0, 6) || 
                       compareBuffers(buffer, fileSignatures.gif89a, 0, 6)) {
                detectedType = 'gif';
            } else if (compareBuffers(buffer, fileSignatures.bmp, 0, 2)) {
                detectedType = 'bmp';
            } else if (compareBuffers(buffer, fileSignatures.webp, 0, 4) && 
                      buffer.toString('ascii', 8, 12) === 'WEBP') {
                detectedType = 'webp';
            } else if (compareBuffers(buffer, fileSignatures.tiffLe, 0, 4) || 
                       compareBuffers(buffer, fileSignatures.tiffBe, 0, 4)) {
                detectedType = 'tiff';
            }
            
            if (detectedType) {
                // 重命名文件，添加正确的扩展名
                const newFileName = specialCases.some(Boolean) ? 
                    `${file}.${detectedType}` :  // 处理特殊点情况，确保添加点
                    `${file}.${detectedType}`;   // 正常情况
                
                const newFilePath = path.join(texturesDir, newFileName);
                fs.renameSync(filePath, newFilePath);
                
                console.log(`[Texture] 模型 ${modelId} 检测到纹理文件类型: ${file} -> ${newFileName}`);
                
                // 更新文件列表
                modifiedFiles[i] = newFileName;
                modifiedCount++;
            } else {
                console.warn(`[Texture] 模型 ${modelId} 无法识别纹理文件类型: ${file}`);
            }
        } catch (err) {
            console.error(`[Texture] 处理纹理文件 ${file} 失败: ${err.message}`);
        }
    }
    
    console.log(`[Texture] 模型 ${modelId} 共处理 ${modifiedCount} 个无后缀名或特殊后缀的纹理文件`);
    return modifiedFiles;
}

/**
 * 将PBRT文件中的*N占位符替换为实际纹理文件名
 * @param {string} pbrtContent PBRT文件内容
 * @param {string} modelDir 模型目录路径
 * @param {string} modelId 模型UUID
 * @returns {string} 处理后的PBRT内容
 */
function replaceTextureReferences(pbrtContent, modelDir, modelId) {
    // 读取模型对应的纹理目录
    const texturesDir = path.join(modelDir, 'textures');
    if (!fs.existsSync(texturesDir)) {
        console.log(`[Texture] 模型 ${modelId} 没有纹理目录，跳过纹理替换`);
        return pbrtContent;
    }
    
    // 检测无后缀名的图像文件并修复
    const textureFiles = detectAndFixImageFileExtensions(texturesDir, modelId);
    
    if (textureFiles.length === 0) {
        console.log(`[Texture] 模型 ${modelId} 的纹理目录为空，跳过纹理替换`);
        return pbrtContent;
    }
    
    console.log(`[Texture] 模型 ${modelId} 发现 ${textureFiles.length} 个纹理文件: ${textureFiles.join(', ')}`);
    
    // 对文件进行排序（按名称排序）
    textureFiles.sort();
    
    // 替换所有 *N 引用
    let modifiedContent = pbrtContent;
    
    // 处理标准格式: "string filename" "models/uuid/textures/*N"
    const placeholderPattern = /"string filename"\s+"models\/[^\/]+\/textures\/\*(\d+)"/g;
    let match;
    let replaceCount = 0;
    
    while ((match = placeholderPattern.exec(pbrtContent)) !== null) {
        const fullMatch = match[0];
        const index = parseInt(match[1]);
        
        if (index < textureFiles.length) {
            const replacement = `"string filename" "models/${modelId}/textures/${textureFiles[index]}"`;
            modifiedContent = modifiedContent.replace(fullMatch, replacement);
            console.log(`[Texture] 替换占位符 *${index} -> ${textureFiles[index]}`);
            replaceCount++;
        } else {
            console.warn(`[Texture] 警告: 占位符 *${index} 超出可用纹理文件范围(0-${textureFiles.length-1})`);
        }
    }
    
    // 处理简单格式: "string filename" "*N"
    const simplePlaceholderPattern = /"string filename"\s+"\*(\d+)"/g;
    while ((match = simplePlaceholderPattern.exec(pbrtContent)) !== null) {
        const fullMatch = match[0];
        const index = parseInt(match[1]);
        
        if (index < textureFiles.length) {
            const replacement = `"string filename" "models/${modelId}/textures/${textureFiles[index]}"`;
            modifiedContent = modifiedContent.replace(fullMatch, replacement);
            console.log(`[Texture] 替换简单占位符 *${index} -> ${textureFiles[index]}`);
            replaceCount++;
        } else {
            console.warn(`[Texture] 警告: 简单占位符 *${index} 超出可用纹理文件范围(0-${textureFiles.length-1})`);
        }
    }
    
    // 处理绝对路径格式中的占位符: "string filename" "/path/to/*N"
    const absolutePlaceholderPattern = /"string filename"\s+"[^"]*\/\*(\d+)"/g;
    while ((match = absolutePlaceholderPattern.exec(pbrtContent)) !== null) {
        const fullMatch = match[0];
        const index = parseInt(match[1]);
        
        // 避免重复处理已经匹配过的模式
        if (!fullMatch.includes(`models/${modelId}/textures/*${index}`) && 
            !fullMatch.includes(`"*${index}"`) &&
            index < textureFiles.length) {
            const replacement = `"string filename" "models/${modelId}/textures/${textureFiles[index]}"`;
            modifiedContent = modifiedContent.replace(fullMatch, replacement);
            console.log(`[Texture] 替换绝对路径占位符 *${index} -> ${textureFiles[index]}`);
            replaceCount++;
        }
    }
    
    console.log(`[Texture] 模型 ${modelId} 共替换了 ${replaceCount} 个纹理占位符`);
    return modifiedContent;
}

/**
 * @route GET /v1/convert/:uuid
 * @description 将指定UUID的模型转换为PBRT格式
 * @param {string} uuid - 模型的唯一标识
 * @returns {Object} 转换结果
 * @throws {404} 模型不存在时
 * @throws {500} 转换失败时
 */
app.get('/v1/convert/:uuid', asyncHandler(async (req, res) => {
    try {
        const modelId = req.params.uuid;
        const modelDir = path.join(MODELS_DIR, modelId);

        // 检查模型目录是否存在
        if (!fs.existsSync(modelDir)) {
            return res.status(404).json({ error: '模型不存在' });
        }

        // 读取模型信息
        const infoPath = path.join(modelDir, 'info.json');
        if (!fs.existsSync(infoPath)) {
            return res.status(404).json({ error: '模型信息文件不存在' });
        }

        const modelInfo = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
        const modelPath = modelInfo.model_path;

        // 检查模型文件是否存在
        const modelFilePath = path.join(modelDir, modelPath);
        if (!fs.existsSync(modelFilePath)) {
            return res.status(404).json({ error: '模型文件不存在' });
        }

        // 检查是否已经转换过
        const nonoPbrtPath = path.join(modelDir, 'nono.pbrt');
        let alreadyConverted = false;
        
        if (fs.existsSync(nonoPbrtPath)) {
            alreadyConverted = true;
            console.log(`[Convert] 模型 ${modelId} 已经转换过，将处理纹理和材质名称前缀`);
        } else {
            // 执行assimp命令进行转换
            try {
                const execFile = util.promisify(childProcess.execFile);
                
                // 切换到模型目录并执行assimp
                console.log(`[Convert] 当前目录: ${modelDir}`);
                console.log(`[Convert] 模型文件: ${modelPath}`);
                
                // 使用绝对路径确保文件能被找到
                const fullModelPath = path.join(modelDir, modelPath);
                console.log(`[Convert] 完整模型路径: ${fullModelPath}`);
                
                // 处理文件中可能包含的空格和特殊字符
                // 创建一个没有特殊字符的临时文件进行处理
                const fileExt = path.extname(fullModelPath);
                const tempFilename = `temp_model_${Date.now()}${fileExt}`;
                const tempFilePath = path.join(modelDir, tempFilename);
                
                // 复制文件到临时文件
                fs.copyFileSync(fullModelPath, tempFilePath);
                console.log(`[Convert] 为防止特殊字符问题，创建临时文件: ${tempFilePath}`);
                
                try {
                    // 确保textures目录存在 - 使用try/catch包裹，避免权限问题
                    try {
                        // 先检查textures目录是否已存在
                        const texturesDir = path.join(modelDir, 'textures');
                        if (!fs.existsSync(texturesDir)) {
                            console.log(`[Convert] 正在创建textures目录: ${texturesDir}`);
                            // 使用递归选项确保父目录也被创建
                            fs.mkdirSync(texturesDir, { recursive: true, mode: 0o777 });
                            console.log(`[Convert] 成功创建textures目录, 权限: ${fs.statSync(texturesDir).mode.toString(8)}`);
                        } else {
                            console.log(`[Convert] textures目录已存在: ${texturesDir}`);
                        }
                        
                        // 验证目录权限
                        try {
                            const testFile = path.join(modelDir, 'textures', 'test.txt');
                            fs.writeFileSync(testFile, 'test');
                            fs.unlinkSync(testFile);
                            console.log(`[Convert] textures目录权限正常, 可以写入文件`);
                        } catch (permErr) {
                            console.warn(`[Convert] textures目录权限问题: ${permErr.message}`);
                        }
                    } catch (dirErr) {
                        console.warn(`[Convert] 创建textures目录失败: ${dirErr.message}, 但继续尝试转换`);
                    }

                    // 使用临时文件名，但确保在命令行中正确引用完整路径
                    console.log(`[Convert] 执行assimp命令: assimp export ${tempFilename} no -fpbrt full`);
                    const result = await execFile('assimp', ['export', tempFilename, 'no', '-fpbrt', 'full'], {
                        cwd: modelDir
                    });

                    console.log(`[Convert] 成功转换模型 ${modelId} 为PBRT格式`);
                    if (result.stderr) {
                        console.warn(`[Convert] 转换警告: ${result.stderr}`);
                    }
                    if (result.stdout) {
                        console.log(`[Convert] 转换输出: ${result.stdout}`);
                    }
                } finally {
                    // 无论成功失败，都尝试删除临时文件
                    try {
                        if (fs.existsSync(tempFilePath)) {
                            fs.unlinkSync(tempFilePath);
                            console.log(`[Convert] 已删除临时文件: ${tempFilename}`);
                        }
                    } catch (e) {
                        console.warn(`[Convert] 删除临时文件失败: ${e.message}`);
                    }
                }
                
                // 检查输出文件是否存在
                const expectedPath = path.join(modelDir, 'no.pbrt');
                if (fs.existsSync(expectedPath)) {
                    // 如果输出文件名是no.pbrt（而不是nono.pbrt），则重命名
                    fs.renameSync(expectedPath, nonoPbrtPath);
                }

                // 检查转换后的文件是否存在
                if (!fs.existsSync(nonoPbrtPath)) {
                    throw new Error('转换后的PBRT文件不存在');
                }
            } catch (error) {
                console.error(`[Convert] 执行assimp命令失败: ${error.message}`);
                // 添加更多错误信息方便调试
                if (error.stderr) {
                    console.error(`[Convert] 错误输出: ${error.stderr}`);
                }
                if (error.stdout) {
                    console.error(`[Convert] 标准输出: ${error.stdout}`);
                }
                throw new Error(`模型转换失败: ${error.message}`);
            }
        }

        // 处理nono.pbrt文件内容，删除#Textures之前的所有内容，添加材质前缀
        try {
            // 读取文件内容
            const pbrtContent = fs.readFileSync(nonoPbrtPath, 'utf8');
            
            // 查找# Textures位置
            const texturesIndex = pbrtContent.indexOf('# Textures');
            
            if (texturesIndex !== -1) {
                // 保留# Textures及其之后的内容
                let newContent = pbrtContent.substring(texturesIndex);
                
                // 新功能：为纹理和材质添加UUID前缀
                console.log(`[Convert] 开始处理nono.pbrt文件中的材质和纹理名称`);
                
                // 获取UUID前八位作为前缀
                const prefix = modelId.substring(0, 8) + '-';
                
                // 存储需要重命名的材质和纹理名称映射
                const materialMap = new Map();
                const textureMap = new Map();
                
                // 匹配定义的所有纹理
                const texturePattern = /Texture\s+"([^"]+)"\s+"([^"]+)"\s+"([^"]+)"/g;
                let textureMatch;
                while ((textureMatch = texturePattern.exec(newContent)) !== null) {
                    const originalName = textureMatch[1];
                    if (!originalName.includes(prefix)) {
                        // 只有不包含前缀的才需要重命名
                        const newName = originalName.startsWith('rgb:') ? 
                            `rgb:${prefix}${originalName.substring(4)}` : 
                            `${prefix}${originalName}`;
                        textureMap.set(originalName, newName);
                    }
                }
                
                // 使用通用方法让所有纹理路径使用相对路径，设置useRelativePath为true
                newContent = sanitizePbrtPaths(newContent, modelDir, true);
                console.log(`[Convert] 已规范化所有纹理路径为相对路径`);
                
                // 检查PBRT文件中是否存在特殊的*N引用格式，如果有则更新为标准相对路径格式
                const pbrtSpecialRegex = /"string filename"\s+"[^"]*\*(\d+)"/g;
                let pbrtMatch;
                while ((pbrtMatch = pbrtSpecialRegex.exec(newContent)) !== null) {
                    const textureIndex = pbrtMatch[1];
                    console.log(`[Convert] 发现特殊纹理引用格式: *${textureIndex}，转换为相对路径格式`);
                }
                
                // 修正PBRT文件中的纹理路径，确保使用models/{uuid}/textures/*N格式
                const texPathRegex = /"string filename"\s+"([^"]+)"/g;
                const updatedPaths = new Map();
                
                while ((texPathMatch = texPathRegex.exec(newContent)) !== null) {
                    const originalPath = texPathMatch[1];
                    // 如果是绝对路径，转换为相对路径
                    if (originalPath.startsWith('/home/pog/pbrtapi/uploads/models/')) {
                        // 从uploads目录开始的相对路径
                        const relativePath = originalPath.replace('/home/pog/pbrtapi/uploads/', '');
                        updatedPaths.set(originalPath, relativePath);
                        console.log(`[Convert] 转换纹理路径为相对路径: ${originalPath} -> ${relativePath}`);
                    }
                    // 已经是相对路径或其他特殊情况则不处理
                }
                
                // 应用路径更新
                updatedPaths.forEach((newPath, oldPath) => {
                    const escOldPath = escapeRegExp(oldPath);
                    newContent = newContent.replace(
                        new RegExp(`"string filename"\\s+"${escOldPath}"`, 'g'),
                        `"string filename" "${newPath}"`
                    );
                });
                
                // 检查空名称材质的处理
                const emptyMaterialPattern = /MakeNamedMaterial\s+""\s+/g;
                let emptyMatches = [];
                let emptyMatch;
                
                // 查找所有空名称材质
                while ((emptyMatch = emptyMaterialPattern.exec(newContent)) !== null) {
                    emptyMatches.push(emptyMatch.index);
                }
                
                // 检查是否有多个空名称材质
                if (emptyMatches.length > 1) {
                    const errorMsg = `发现${emptyMatches.length}个空名称材质（MakeNamedMaterial ""），每个PBRT文件中只允许有一个空名称材质。`;
                    console.error(`[Convert] ${errorMsg}`);
                    throw new Error(errorMsg);
                }
                
                // 如果有一个空名称材质，为其分配唯一名称
                if (emptyMatches.length === 1) {
                    const uniqueEmptyName = `${prefix}noname_material`;
                    console.log(`[Convert] 找到空名称材质，将分配唯一名称: ${uniqueEmptyName}`);
                    
                    // 添加到材质映射
                    materialMap.set("", uniqueEmptyName);
                }
                
                // 匹配定义的所有材质
                const materialPattern = /MakeNamedMaterial\s+"([^"]*)"\s+/g;
                let materialMatch;
                let emptyMaterialAlreadyProcessed = materialMap.has("");
                
                while ((materialMatch = materialPattern.exec(newContent)) !== null) {
                    const originalName = materialMatch[1];
                    // 空材质名称已经在前面处理过，这里跳过
                    if (originalName === "" && emptyMaterialAlreadyProcessed) {
                        continue;
                    }
                    
                    // 非空材质名称不添加前缀的情况：已包含前缀的材质
                    if (originalName && !originalName.includes(prefix)) {
                        const newName = `${prefix}${originalName}`;
                        materialMap.set(originalName, newName);
                    }
                }
                
                // 记录处理信息
                let materialInfo = `找到 ${materialMap.size} 个材质需要重命名`;
                if (materialMap.has("")) {
                    materialInfo += `，其中包含一个空名称材质，已重命名为 ${materialMap.get("")}`;
                }
                
                console.log(`[Convert] ${materialInfo}`);
                console.log(`[Convert] 找到 ${textureMap.size} 个纹理需要重命名`);
                
                // 替换所有纹理定义
                textureMap.forEach((newName, originalName) => {
                    const textureDefRegex = new RegExp(`Texture\\s+"${escapeRegExp(originalName)}"\\s+`, 'g');
                    newContent = newContent.replace(textureDefRegex, `Texture "${newName}" `);
                    
                    // 同时替换引用到该纹理的地方
                    const textureRefRegex = new RegExp(`"texture\\s+[^"]*"\\s+"${escapeRegExp(originalName)}"`, 'g');
                    newContent = newContent.replace(textureRefRegex, (match) => {
                        return match.replace(`"${originalName}"`, `"${newName}"`);
                    });
                });
                
                // 替换所有材质定义
                materialMap.forEach((newName, originalName) => {
                    // 替换材质定义
                    const materialDefRegex = new RegExp(`MakeNamedMaterial\\s+"${escapeRegExp(originalName)}"\\s+`, 'g');
                    newContent = newContent.replace(materialDefRegex, `MakeNamedMaterial "${newName}" `);
                    
                    // 替换材质引用
                    if (originalName === "") {
                        // 特殊处理空名称材质引用
                        // 先处理有引号的情况
                        const emptyMaterialRefRegex = new RegExp(`NamedMaterial\\s+""`, 'g');
                        newContent = newContent.replace(emptyMaterialRefRegex, `NamedMaterial "${newName}"`);
                    } else {
                        // 处理正常材质引用
                        const materialRefRegex = new RegExp(`NamedMaterial\\s+"${escapeRegExp(originalName)}"`, 'g');
                        newContent = newContent.replace(materialRefRegex, `NamedMaterial "${newName}"`);
                    }
                });
                
                // 写回文件
                fs.writeFileSync(nonoPbrtPath, newContent, 'utf8');
                console.log(`[Convert] 成功处理nono.pbrt文件，添加了材质和纹理名称前缀: ${prefix}`);
                
                // 新增步骤：替换*N占位符为实际纹理文件名
                const processedContent = replaceTextureReferences(newContent, modelDir, modelId);
                if (processedContent !== newContent) {
                    fs.writeFileSync(nonoPbrtPath, processedContent, 'utf8');
                    console.log(`[Convert] 成功替换nono.pbrt文件中的纹理占位符为实际文件名`);
                }
            } else {
                console.warn(`[Convert] 未找到#Textures标记，nono.pbrt保持原样`);
            }
        } catch (fileError) {
            console.error(`[Convert] 处理nono.pbrt文件失败: ${fileError.message}`);
            // 不中断流程，继续执行
        }

        // 在info.json中添加转换信息
        modelInfo.pbrt_converted = true;
        modelInfo.nono_available = true; // 添加nono_available标志
        modelInfo.momo_available = false;
        modelInfo.pbrt_convert_date = new Date().toISOString();
        fs.writeFileSync(infoPath, JSON.stringify(modelInfo, null, 4), 'utf8');

        res.json({ 
            message: alreadyConverted ? '模型已存在，已更新材质前缀' : '模型转换成功', 
            uuid: modelId, 
            nono_pbrt: 'nono.pbrt' 
        });
    } catch (error) {
        console.error('模型转换失败:', error);
        res.status(500).json({ error: error.message || '模型转换失败' });
    }
}));

/**
 * @route GET /v1/model/nono/:uuid
 * @description 获取指定UUID的模型转换后的nono.pbrt文件
 * @param {string} uuid - 模型的唯一标识
 * @returns {file} nono.pbrt文件
 * @throws {404} 模型或PBRT文件不存在时
 * @throws {500} 获取文件失败时
 */
app.get('/v1/model/nono/:uuid', (req, res) => {
    try {
        const modelId = req.params.uuid;
        const modelDir = path.join(MODELS_DIR, modelId);
        const nonoPbrtPath = path.join(modelDir, 'nono.pbrt');

        if (!fs.existsSync(modelDir)) {
            return res.status(404).json({ error: '模型不存在' });
        }

        if (!fs.existsSync(nonoPbrtPath)) {
            return res.status(404).json({ error: 'nono.pbrt文件不存在，请先转换模型' });
        }

        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="nono-${modelId}.pbrt"`);
        fs.createReadStream(nonoPbrtPath).pipe(res);
    } catch (error) {
        console.error('获取nono.pbrt文件失败:', error);
        res.status(500).json({ error: '获取nono.pbrt文件失败' });
    }
});

/**
 * @route GET /v1/model/momo/:uuid
 * @description 获取指定UUID的模型的momo.pbrt文件
 * @param {string} uuid - 模型的唯一标识
 * @returns {file} momo.pbrt文件
 * @throws {404} 模型或PBRT文件不存在时
 * @throws {500} 获取文件失败时
 */
app.get('/v1/model/momo/:uuid', (req, res) => {
    try {
        const modelId = req.params.uuid;
        const modelDir = path.join(MODELS_DIR, modelId);
        const momoPbrtPath = path.join(modelDir, 'momo.pbrt');

        if (!fs.existsSync(modelDir)) {
            return res.status(404).json({ error: '模型不存在' });
        }

        if (!fs.existsSync(momoPbrtPath)) {
            return res.status(404).json({ error: 'momo.pbrt文件不存在' });
        }

        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="momo-${modelId}.pbrt"`);
        fs.createReadStream(momoPbrtPath).pipe(res);
    } catch (error) {
        console.error('获取momo.pbrt文件失败:', error);
        res.status(500).json({ error: '获取momo.pbrt文件失败' });
    }
});

/**
 * @route GET /v1/model/:uuid
 * @description 获取指定UUID的模型信息
 * @param {string} uuid - 模型的唯一标识
 * @returns {Object} 模型信息
 * @throws {404} 模型不存在时
 * @throws {500} 获取模型失败时
 */
app.get('/v1/model/:uuid', (req, res) => {
    try {
        const modelId = req.params.uuid;
        const modelDir = path.join(MODELS_DIR, modelId);
        const infoPath = path.join(modelDir, 'info.json');

        if (!fs.existsSync(modelDir) || !fs.existsSync(infoPath)) {
            return res.status(404).json({ error: '模型不存在' });
        }

        const modelInfo = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
        res.json(modelInfo);
    } catch (error) {
        console.error('获取模型信息失败:', error);
        res.status(500).json({ error: '获取模型信息失败' });
    }
});

/**
 * @route POST /v1/transform
 * @description 将指定UUID的nono.pbrt文件进行变换并生成momo.pbrt
 * @param {string} uuid - 模型的唯一标识
 * @param {array} [translate] - 可选参数，三元组，表示平移量 [x, y, z]
 * @param {array} [rotate] - 可选参数，四元组，表示旋转量 [angle, x, y, z]
 * @param {array} [scale] - 可选参数，三元组，表示缩放量 [x, y, z]
 * @returns {Object} 转换结果
 * @throws {404} 模型或nono.pbrt文件不存在时
 * @throws {500} 转换失败时
 */
app.post('/v1/transform', express.json(), asyncHandler(async (req, res) => {
    try {
        const { uuid, translate, rotate, scale } = req.body;
        
        if (!uuid) {
            return res.status(400).json({ error: '缺少必要参数：uuid' });
        }
        
        // 验证参数格式
        if (translate && (!Array.isArray(translate) || translate.length !== 3)) {
            return res.status(400).json({ error: 'translate参数必须是长度为3的数组 [x, y, z]' });
        }
        
        if (rotate && (!Array.isArray(rotate) || rotate.length !== 4)) {
            return res.status(400).json({ error: 'rotate参数必须是长度为4的数组 [angle, x, y, z]' });
        }
        
        if (scale && (!Array.isArray(scale) || scale.length !== 3)) {
            return res.status(400).json({ error: 'scale参数必须是长度为3的数组 [x, y, z]' });
        }
        
        const modelDir = path.join(MODELS_DIR, uuid);
        const nonoPbrtPath = path.join(modelDir, 'nono.pbrt');
        const momoPbrtPath = path.join(modelDir, 'momo.pbrt');
        const infoPath = path.join(modelDir, 'info.json');
        
        // 检查目录和文件是否存在
        if (!fs.existsSync(modelDir)) {
            return res.status(404).json({ error: '模型不存在' });
        }
        
        if (!fs.existsSync(nonoPbrtPath)) {
            return res.status(404).json({ error: 'nono.pbrt文件不存在，请先转换模型' });
        }
        
        // 读取nono.pbrt文件内容
        const pbrtContent = fs.readFileSync(nonoPbrtPath, 'utf8');
        
        // 生成变换命令字符串
        const transformCommands = [];
        if (translate) {
            transformCommands.push(`  Translate ${translate[0]} ${translate[1]} ${translate[2]}`);
        }
        if (rotate) {
            transformCommands.push(`  Rotate ${rotate[0]} ${rotate[1]} ${rotate[2]} ${rotate[3]}`);
        }
        if (scale) {
            transformCommands.push(`  Scale ${scale[0]} ${scale[1]} ${scale[2]}`);
        }
        
        // 生成变换命令
        const transformStr = transformCommands.join('\n');
        
        // 在文件开头添加注释，记录时间和变换参数
        const timestamp = new Date().toISOString();
        let headerComment = `# Transform applied on ${timestamp}\n`;
        headerComment += `# Parameters:\n`;
        headerComment += translate ? `# - Translate: [${translate.join(', ')}]\n` : '# - Translate: none\n';
        headerComment += rotate ? `# - Rotate: [${rotate.join(', ')}]\n` : '# - Rotate: none\n';
        headerComment += scale ? `# - Scale: [${scale.join(', ')}]\n` : '# - Scale: none\n';
        headerComment += `#-------------------------------------------\n\n`;
          
        // 使用正则表达式查找所有AttributeBegin/AttributeEnd对
        const attributePattern = /(#.*\n)?\s*(AttributeBegin\s*(?:[^\n]*\n)+?)(?=\s*Shape|\s*Material|\s*NamedMaterial|\s*LightSource|\s*CoordSysTransform|\s*AttributeEnd)/g;
        
        let modifiedContent = pbrtContent;
        let match;
        
        // 使用循环处理每个匹配项
        while ((match = attributePattern.exec(pbrtContent)) !== null) {
            const fullMatch = match[0];
            const commentLine = match[1] || '';
            const attrBlock = match[2];
            
            // 检查是否有no-more-transformation标记
            if (commentLine && commentLine.includes('#[no-more-transformation]')) {
                continue; // 跳过这个块
            }
            
            // 检查是否已经有变换命令
            const hasTranslate = /\s+Translate\s+/.test(attrBlock);
            const hasRotate = /\s+Rotate\s+/.test(attrBlock);
            const hasScale = /\s+Scale\s+/.test(attrBlock);
            
            // 如果没有变换命令或需要添加新命令
            if (transformCommands.length > 0) {
                let replacementText;
                
                if (hasTranslate || hasRotate || hasScale) {
                    // 查找最后一个变换命令
                    const commands = ['Translate', 'Rotate', 'Scale'];
                    let lastPos = -1;
                    let lastCommand = '';
                    
                    for (const cmd of commands) {
                        const pos = attrBlock.lastIndexOf(cmd);
                        if (pos > lastPos) {
                            lastPos = pos;
                            lastCommand = cmd;
                        }
                    }
                    
                    if (lastPos !== -1) {
                        // 找到命令所在行的结束位置
                        const lineEnd = attrBlock.indexOf('\n', lastPos);
                        if (lineEnd !== -1) {
                            // 在最后一个变换命令后插入新命令
                            replacementText = commentLine + 
                                             attrBlock.substring(0, lineEnd + 1) + 
                                             transformStr + '\n' + 
                                             attrBlock.substring(lineEnd + 1);
                        } else {
                            // 如果找不到换行符，附加到块末尾
                            replacementText = commentLine + attrBlock + '\n' + transformStr + '\n';
                        }
                    } else {
                        // 如果没有找到变换命令（不应该发生），附加到块末尾
                        replacementText = commentLine + attrBlock + transformStr + '\n';
                    }
                } else {
                    // 如果没有变换命令，在AttributeBegin后添加
                    replacementText = commentLine + attrBlock + transformStr + '\n';
                }
                
                // 替换原始匹配的内容
                modifiedContent = modifiedContent.replace(fullMatch, replacementText);
                // 更新模式匹配位置，避免无限循环
                attributePattern.lastIndex += (replacementText.length - fullMatch.length);
            }
        }
        
        // 构建最终文件内容
        const finalContent = headerComment + modifiedContent;
        
        // 修复AttributeEndAttributeBegin问题 - 添加换行符
        const fixedContent = finalContent.replace(/AttributeEndAttributeBegin/g, "AttributeEnd\nAttributeBegin");
        
        // 添加修复绝对路径为相对路径的处理
        // 使用通用方法将所有路径规范化为相对路径
        const relativePathContent = sanitizePbrtPaths(fixedContent, modelDir, true);
        
        // 写入momo.pbrt文件
        fs.writeFileSync(momoPbrtPath, relativePathContent, 'utf8');
        
        // 新增步骤：替换*N占位符为实际纹理文件名
        const processedContent = replaceTextureReferences(relativePathContent, modelDir, uuid);
        if (processedContent !== relativePathContent) {
            fs.writeFileSync(momoPbrtPath, processedContent, 'utf8');
            console.log(`[Transform] 成功替换momo.pbrt文件中的纹理占位符为实际文件名`);
        }
        
        // 更新info.json
        if (fs.existsSync(infoPath)) {
            try {
                const modelInfo = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
                modelInfo.momo_available = true;
                modelInfo.momo_transform = {
                    timestamp,
                    translate: translate || null,
                    rotate: rotate || null,
                    scale: scale || null
                };
                fs.writeFileSync(infoPath, JSON.stringify(modelInfo, null, 4), 'utf8');
            } catch (err) {
                console.error(`[Transform] 更新info.json失败: ${err.message}`);
                // 不中断流程
            }
        }
        
        res.json({
            message: '模型转换成功',
            uuid,
            momo_pbrt: 'momo.pbrt',
            transforms: {
                translate: translate || null,
                rotate: rotate || null,
                scale: scale || null
            }
        });
        
    } catch (error) {
        console.error('模型变换失败:', error);
        res.status(500).json({ error: error.message || '模型变换失败' });
    }
}));

// 添加全局错误处理中间件
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({
                error: '文件大小超过限制（最大1GB）'
            });
        }
        return res.status(400).json({
            error: `文件上传错误: ${error.message}`
        });
    }
    
    // 处理所有其他错误
    console.error('全局错误处理捕获到异常:', error);
    
    // 防止响应已发送时再次发送
    if (!res.headersSent) {
        return res.status(500).json({
            error: `服务器内部错误: ${error.message || '未知错误'}`
        });
    }
    
    next(error);
});

app.listen(port, () => {
    console.log(`PBRT API listening at http://localhost:${port}`);
});

/**
 * 检查PBRT文件内容中是否存在目录遍历攻击风险
 * @param {string} content PBRT文件内容
 * @returns {boolean} true表示存在安全风险
 */
function hasSuspiciousPbrtPaths(content) {
    const suspiciousPatterns = [
        /"filename"\s+"\.\.\//, // "../"形式的路径
        /"filename"\s+"~\//, // "~/"形式的路径
        /"filename"\s+"\/etc\//, // "/etc/"形式的系统路径
        /"filename"\s+"\/var\//, // "/var/"形式的系统路径
        /"filename"\s+"\\\\/, // Windows网络路径
    ];
    
    return suspiciousPatterns.some(pattern => 
        new RegExp(pattern).test(content)
    );
}

/**
 * 规范化PBRT文件中的纹理路径
 * @param {string} content PBRT文件内容
 * @param {string} baseDir 基准目录，用于构建相对路径的绝对路径
 * @param {boolean} useRelativePath 是否使用相对路径而非绝对路径
 * @returns {string} 处理后的内容
 */
function sanitizePbrtPaths(content, baseDir, useRelativePath = false) {
    // 首先处理绝对路径中的模型纹理引用，将其转换为相对路径格式
    let processedContent = content.replace(
        /\/home\/pog\/pbrtapi\/uploads\/models\/([a-f0-9-]+)\/textures\/\*(\d+)/g,
        (match, modelId, textureIndex) => {
            // 只有在使用相对路径模式时才转换
            if (useRelativePath) {
                return `models/${modelId}/textures/*${textureIndex}`;
            }
            return match; // 否则保持原样
        }
    );
    
    // 然后处理常规的纹理路径
    return processedContent.replace(
        /"string filename"\s+"([^"]+)"/g, 
        (match, filename) => {
            // 如果不是绝对路径，则将其转换为绝对路径或保留相对路径
            if (!filename.startsWith('/')) {
                if (useRelativePath) {
                    // 仅确保路径格式正确
                    const cleanPath = filename.replace(/\\/g, '/');
                    console.log(`[Security] 规范化纹理相对路径: '${filename}' -> '${cleanPath}'`);
                    return `"string filename" "${cleanPath}"`;
                } else {
                    // 转换为绝对路径
                    const safePath = path.join(baseDir, filename).replace(/\\/g, '/');
                    console.log(`[Security] 规范化纹理路径为绝对路径: '${filename}' -> '${safePath}'`);
                    return `"string filename" "${safePath}"`;
                }
            } else if (useRelativePath && filename.startsWith('/home/pog/pbrtapi/uploads/models/')) {
                // 将绝对路径的模型纹理引用转换为相对路径
                const relPath = filename.replace('/home/pog/pbrtapi/uploads/', '');
                console.log(`[Security] 将绝对路径转换为相对路径: '${filename}' -> '${relPath}'`);
                return `"string filename" "${relPath}"`;
            }
            return match;
        }
    );
}
