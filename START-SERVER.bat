@echo off
title Attachment Audit — Odoo Proxy
echo.
echo  =====================================================
echo   Odoo Attachment Audit Portal
echo   Starting proxy on http://localhost:3002
echo  =====================================================
echo.

:: Check if node_modules exists, install if not
if not exist "node_modules\" (
    echo  Installing dependencies (first time only)...
    npm install
    echo.
)

echo  Opening portal in browser...
timeout /t 2 /nobreak >nul
start http://localhost:3002

node attachment-server.js
pause
