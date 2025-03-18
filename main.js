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

// 引入配置文件
const settings = require('./settings.json');

const app = express();
const port = 8001;

// 设置请求大小限制为1GB
app.use(express.json({limit: '1gb'}));
app.use(express.urlencoded({ extended: true, limit: '1gb' }));

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

// 修改模型上传处理部分，添加 RAR 支持
app.post('/v1/model', uploadModel.single('model'), async (req, res) => {
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
                        modelInfo = { ...zipInfo, ...modelInfo }; // 网页编辑器的info优先级更高
                    } catch (e) {
                        console.warn('压缩包中的info.json格式无效，将忽略');
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
});

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

/**
 * @route GET /v1/convert/:uuid
 * @description 将指定UUID的模型转换为PBRT格式
 * @param {string} uuid - 模型的唯一标识
 * @returns {Object} 转换结果
 * @throws {404} 模型不存在时
 * @throws {500} 转换失败时
 */
app.get('/v1/convert/:uuid', async (req, res) => {
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
        if (fs.existsSync(nonoPbrtPath)) {
            return res.json({ 
                message: '模型已经转换', 
                uuid: modelId, 
                nono_pbrt: 'nono.pbrt' 
            });
        }

        // 执行assimp命令进行转换
        try {
            const execFile = util.promisify(childProcess.execFile);
            
            // 切换到模型目录并执行assimp
            console.log(`[Convert] 当前目录: ${modelDir}`);
            console.log(`[Convert] 模型文件: ${modelPath}`);
            
            // 使用绝对路径确保文件能被找到
            const fullModelPath = path.join(modelDir, modelPath);
            console.log(`[Convert] 完整模型路径: ${fullModelPath}`);
            
            // 使用绝对路径调用assimp
            const result = await execFile('assimp', ['export', fullModelPath, 'no', '-fpbrt', 'full'], {
                cwd: modelDir
            });


            console.log(`[Convert] 成功转换模型 ${modelId} 为PBRT格式`);
            if (result.stderr) {
                console.warn(`[Convert] 转换警告: ${result.stderr}`);
            }
            if (result.stdout) {
                console.log(`[Convert] 转换输出: ${result.stdout}`);
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

            // 处理nono.pbrt文件内容，删除#Textures之前的所有内容
            try {
                // 读取文件内容
                const pbrtContent = fs.readFileSync(nonoPbrtPath, 'utf8');
                
                // 查找# Textures位置
                const texturesIndex = pbrtContent.indexOf('# Textures');
                
                if (texturesIndex !== -1) {
                    // 保留# Textures及其之后的内容
                    const newContent = pbrtContent.substring(texturesIndex);
                    
                    // 写回文件
                    fs.writeFileSync(nonoPbrtPath, newContent, 'utf8');
                    console.log(`[Convert] 成功处理nono.pbrt文件`);
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
                message: '模型转换成功', 
                uuid: modelId, 
                nono_pbrt: 'nono.pbrt' 
            });
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
    } catch (error) {
        console.error('模型转换失败:', error);
        res.status(500).json({ error: error.message || '模型转换失败' });
    }
});

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
app.post('/v1/transform', express.json(), async (req, res) => {
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
        
        // 写入momo.pbrt文件
        fs.writeFileSync(momoPbrtPath, finalContent, 'utf8');
        
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
});

/**
 * @route GET /v1/convert/:uuid
 * @description 将指定UUID的模型转换为PBRT格式
 * @param {string} uuid - 模型的唯一标识
 * @returns {Object} 转换结果
 * @throws {404} 模型不存在时
 * @throws {500} 转换失败时
 */
app.get('/v1/convert/:uuid', async (req, res) => {
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
        if (fs.existsSync(nonoPbrtPath)) {
            return res.json({ 
                message: '模型已经转换', 
                uuid: modelId, 
                nono_pbrt: 'nono.pbrt' 
            });
        }

        // 执行assimp命令进行转换
        try {
            const execFile = util.promisify(childProcess.execFile);
            
            // 切换到模型目录并执行assimp
            console.log(`[Convert] 当前目录: ${modelDir}`);
            console.log(`[Convert] 模型文件: ${modelPath}`);
            
            // 使用绝对路径确保文件能被找到
            const fullModelPath = path.join(modelDir, modelPath);
            console.log(`[Convert] 完整模型路径: ${fullModelPath}`);
            
            // 使用绝对路径调用assimp
            const result = await execFile('assimp', ['export', fullModelPath, 'no', '-fpbrt', 'full'], {
                cwd: modelDir
            });


            console.log(`[Convert] 成功转换模型 ${modelId} 为PBRT格式`);
            if (result.stderr) {
                console.warn(`[Convert] 转换警告: ${result.stderr}`);
            }
            if (result.stdout) {
                console.log(`[Convert] 转换输出: ${result.stdout}`);
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

            // 处理nono.pbrt文件内容，删除#Textures之前的所有内容
            try {
                // 读取文件内容
                const pbrtContent = fs.readFileSync(nonoPbrtPath, 'utf8');
                
                // 查找# Textures位置
                const texturesIndex = pbrtContent.indexOf('# Textures');
                
                if (texturesIndex !== -1) {
                    // 保留# Textures及其之后的内容
                    const newContent = pbrtContent.substring(texturesIndex);
                    
                    // 写回文件
                    fs.writeFileSync(nonoPbrtPath, newContent, 'utf8');
                    console.log(`[Convert] 成功处理nono.pbrt文件`);
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
                message: '模型转换成功', 
                uuid: modelId, 
                nono_pbrt: 'nono.pbrt' 
            });
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
    } catch (error) {
        console.error('模型转换失败:', error);
        res.status(500).json({ error: error.message || '模型转换失败' });
    }
});

// 添加错误处理中间件
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
    next(error);
});

app.listen(port, () => {
    console.log(`PBRT API listening at http://localhost:${port}`);
});
