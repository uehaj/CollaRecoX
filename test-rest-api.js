#!/usr/bin/env node

const http = require('http');

const data = JSON.stringify({
  text: 'Test message from REST API'
});

const options = {
  hostname: 'localhost',
  port: 5001,
  path: '/api/rooms/shared-test-session/insert-text',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

console.log('🧪 Testing REST API...');
console.log('URL:', `http://${options.hostname}:${options.port}${options.path}`);
console.log('Data:', data);

const req = http.request(options, (res) => {
  console.log(`Status: ${res.statusCode}`);
  console.log(`Headers:`, res.headers);
  
  let responseData = '';
  res.on('data', (chunk) => {
    responseData += chunk;
  });
  
  res.on('end', () => {
    console.log('Response:', responseData);
  });
});

req.on('error', (error) => {
  console.error('Error:', error);
});

req.write(data);
req.end();