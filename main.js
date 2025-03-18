const express = require('express');
const multer = require('multer');
const path = require('path');
const util = require('util');
const childProcess = require('child_process');
const fs = require('fs');
const uuid = require('uuid');
const os = require('os'); // 引入 os 模块
const AdmZip = require('adm-zip');

const app = express();
const port = 8001;

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

const upload = multer({ storage: storage });

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

// body-parser 中间件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
    fileFilter: function (req, file, cb) {
        // 允许上传的文件类型
        const allowedTypes = ['.glb', '.gltf', '.obj', '.fbx', '.zip', '.blend', '.3ds', '.max', '.ply', '.pbrt'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedTypes.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error(`不支持的文件类型，支持的文件类型有 ${allowedTypes.join(', ')}`));
        }
    }
});

/**
 * @route GET /
 * @description 检查 API 服务是否正在运行
 * @returns {string} 返回服务运行状态消息
 */
app.get('/', (req, res) => {
    res.send('PBRT API is running');
});

/**
 * @route GET /render
 * @description 渲染页面路由，返回渲染视图
 * @returns {void} 渲染 render 视图
 */
app.get('/render', (req, res) => {
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

/**
 * @route GET /v1/list
 * @description 获取用户的渲染任务列表
 * @query {string} userId - 用户唯一标识
 * @returns {Array} 用户的渲染任务列表（当前为空数组）
 * @throws {400} 如果缺少用户ID
 */
app.get('/v1/list', (req, res) => {
    const userId = req.query.userId;
    if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
    }
    console.log(`[List] User ID: ${userId}`);
    res.json([]);
});

/**
 * @route GET /v1/model
 * @description 获取所有已上传模型的信息
 * @returns {Array} 模型信息列表
 * @throws {500} 获取模型列表失败时
 */
app.get('/v1/model', (req, res) => {
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

/**
 * @route POST /v1/model
 * @description 上传新模型
 * @param {file} model - 要上传的模型文件（支持单个模型文件或ZIP压缩包）
 * @param {Object} info - 模型的元信息（JSON格式）
 * @returns {Object} 上传成功的模型信息
 * @throws {400} 模型信息不完整时
 * @throws {500} 上传模型失败时
 */
app.post('/v1/model', uploadModel.single('model'), async (req, res) => {
    const modelDir = req.file ? path.dirname(req.file.path) : null;
    let needCleanup = true;

    try {
        if (!req.file) {
            throw new Error('未提供模型文件');
        }

        const fileExt = path.extname(req.file.originalname).toLowerCase();
        let modelInfo;

        if (fileExt === '.zip') {
            // 处理zip文件
            try {
                const zip = new AdmZip(req.file.path);
                
                // 解压文件
                zip.extractAllTo(modelDir, true);  // true 表示覆盖已存在的文件
                
                // 删除zip文件
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
                        modelInfo = { ...zipInfo, ...modelInfo }; // 网页编辑器的info优先级更高
                    } catch (e) {
                        console.warn('压缩包中的info.json格式无效，将忽略');
                    }
                }

                // 递归查找模型文件
                const allowedExts = ['.glb', '.gltf', '.obj', '.fbx', '.blend', '.3ds', '.max', '.ply', '.pbrt'];
                const keepExts = [...allowedExts, '.mtl', '.jpg', '.jpeg', '.png', '.gif', '.exr', '.webp', '.bmp', '.json', '.gz', '.spd', '.csv'];
                let modelFiles = [];

                function findModelFilesRecursively(dir, relativePath = '') {
                    const files = fs.readdirSync(dir);
                    for (const file of files) {
                        const fullPath = path.join(dir, file);
                        const relPath = path.join(relativePath, file);
                        const stat = fs.statSync(fullPath);

                        if (stat.isDirectory()) {
                            // 如果是目录，递归查找
                            findModelFilesRecursively(fullPath, relPath);
                        } else if (allowedExts.includes(path.extname(file).toLowerCase())) {
                            // 如果是模型文件，添加到列表
                            modelFiles.push(relPath);
                        }
                    }
                }

                // 清理无关文件
                function cleanupFiles(dir, relativePath = '') {
                    const files = fs.readdirSync(dir);
                    for (const file of files) {
                        const fullPath = path.join(dir, file);
                        const relPath = path.join(relativePath, file);
                        const stat = fs.statSync(fullPath);

                        if (stat.isDirectory()) {
                            if (file.toLowerCase() === 'texture' || file.toLowerCase() === 'textures') {
                                // 保留texture目录下的所有文件
                                continue;
                            }
                            // 递归处理子目录
                            cleanupFiles(fullPath, relPath);
                            // 如果目录为空，删除目录
                            if (fs.readdirSync(fullPath).length === 0) {
                                fs.rmdirSync(fullPath);
                            }
                        } else {
                            // 检查文件扩展名
                            const ext = path.extname(file).toLowerCase();
                            if (!keepExts.includes(ext)) {
                                // 删除不在保留列表中的文件
                                fs.unlinkSync(fullPath);
                            }
                        }
                    }
                }

                // 先查找所有模型文件
                findModelFilesRecursively(modelDir);
                
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
                    (path.extname(modelInfo.model_path).substring(1).toUpperCase() === 'GLB' ? 'GLTF' : 
                    path.extname(modelInfo.model_path).substring(1).toUpperCase());
                modelInfo.upload_date = new Date().toISOString();

                // 验证模型文件是否存在
                validateModelPath(modelDir, modelInfo.model_path);

                // 如果是OBJ格式，检查MTL文件（如果在info中指定了）
                if (path.extname(modelInfo.model_path).toLowerCase() === '.obj' && modelInfo.mtl_path) {
                    validateModelPath(modelDir, modelInfo.mtl_path);
                }

            } catch (error) {
                throw new Error(`处理ZIP文件失败: ${error.message}`);
            }
        } else {
            // 处理单个模型文件
            try {
                modelInfo = JSON.parse(req.body.info || '{}');
            } catch (e) {
                modelInfo = {};
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
});

/**
 * @route DELETE /v1/model/:uuid
 * @description 删除指定的模型
 * @param {string} uuid - 模型的唯一标识
 * @returns {Object} 删除成功的消息
 * @throws {404} 模型不存在时
 * @throws {500} 删除模型失败时
 */
app.delete('/v1/model/:uuid', (req, res) => {
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

// GET /debug/models - 模型管理调试页面
app.get('/debug/models', (req, res) => {
    res.render('debug-models');
});

app.listen(port, () => {
    console.log(`PBRT API listening at http://localhost:${port}`);
});
