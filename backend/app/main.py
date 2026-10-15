# Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
"""ProjectDesk application entrypoint.

Run from the backend directory:
    ../.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8321
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .api import APIError
from .db import connect, db_path, init_db
from .routes import build_router


def create_app(db_file: Optional[str] = None) -> FastAPI:
    path = os.path.abspath(db_file) if db_file else db_path()
    conn = connect(path)
    init_db(conn)

    app = FastAPI(title="ProjectDesk", version=__version__)
    app.state.conn = conn
    app.state.db_path = path
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(build_router())

    @app.exception_handler(APIError)
    async def api_error_handler(request: Request, exc: APIError) -> JSONResponse:
        return JSONResponse(
            {"error": exc.error, "message": exc.message, **exc.extra},
            status_code=exc.status,
        )

    dist = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=str(dist), html=True), name="static")
    else:
        @app.get("/")
        def root() -> dict:
            return {"app": "projectdesk", "version": __version__,
                    "docs": "/docs", "frontend": "dist not built — "
                    "run `npm run build` in frontend/"}

    return app


app = create_app()
