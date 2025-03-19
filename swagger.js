const swaggerAutogen = require('swagger-autogen')();

const doc = {
  info: {
    title: 'PBRT API文档',
    description: 'PBRT渲染API接口文档',
    version: '1.0.0'
  },
  host: 'home.hhzm.win:3001',
  basePath: '/',
  schemes: ['https'],
  consumes: ['application/json', 'multipart/form-data'],
  produces: ['application/json', 'image/png'],
  tags: [
    {
      name: '渲染相关',
      description: '渲染PBRT文件相关的API'
    },
    {
      name: '模型相关',
      description: '3D模型转换和管理相关的API'
    },
    {
      name: '系统状态',
      description: '系统状态和调试相关的API'
    }
  ],
  securityDefinitions: {},
  definitions: {
    TransformRequest: {
      $position: {
        x: 0,
        y: 0,
        z: 0
      },
      $rotation: {
        x: 0,
        y: 0,
        z: 0
      },
      $scale: {
        x: 1,
        y: 1,
        z: 1
      }
    }
  }
};

const outputFile = './swagger_output.json';
const endpointsFiles = ['./main.js'];

// 生成swagger文档
swaggerAutogen(outputFile, endpointsFiles, doc); 