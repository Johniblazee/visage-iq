import io
import json
import logging
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaIoBaseDownload

from backend.config import settings

logger = logging.getLogger(__name__)

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
FOLDER_MIME = "application/vnd.google-apps.folder"
LIST_FIELDS = "nextPageToken,files(id,name,mimeType,modifiedTime)"


class DriveError(Exception):
    pass


@dataclass(frozen=True)
class DriveFile:
    id: str
    name: str
    mime_type: str
    modified_time: datetime | None


def _load_credentials():
    if not settings.gdrive_sa_json:
        raise DriveError(
            "GDRIVE_SA_JSON is not set. Paste the full contents of your "
            "service-account JSON key into the GDRIVE_SA_JSON env var."
        )
    try:
        info = json.loads(settings.gdrive_sa_json)
    except json.JSONDecodeError as exc:
        raise DriveError(f"GDRIVE_SA_JSON is not valid JSON: {exc}") from exc
    return service_account.Credentials.from_service_account_info(info, scopes=SCOPES)


@lru_cache(maxsize=1)
def _service():
    if not settings.gdrive_folder_id:
        raise DriveError("GDRIVE_FOLDER_ID not set")
    creds = _load_credentials()
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def _parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _list_children(folder_id: str) -> Iterator[dict]:
    svc = _service()
    page_token = None
    q = f"'{folder_id}' in parents and trashed=false"
    while True:
        try:
            resp = (
                svc.files()
                .list(
                    q=q,
                    fields=LIST_FIELDS,
                    pageSize=1000,
                    pageToken=page_token,
                    supportsAllDrives=True,
                    includeItemsFromAllDrives=True,
                )
                .execute()
            )
        except HttpError as exc:
            raise DriveError(f"Drive list failed for folder {folder_id}: {exc}") from exc
        for item in resp.get("files", []):
            yield item
        page_token = resp.get("nextPageToken")
        if not page_token:
            return


def list_image_files(folder_id: str | None = None, recursive: bool | None = None) -> Iterator[DriveFile]:
    folder_id = folder_id or settings.gdrive_folder_id
    recursive = settings.gdrive_recursive if recursive is None else recursive
    stack = [folder_id]
    seen_folders: set[str] = set()
    while stack:
        current = stack.pop()
        if current in seen_folders:
            continue
        seen_folders.add(current)
        for item in _list_children(current):
            mime = item["mimeType"]
            if mime == FOLDER_MIME:
                if recursive:
                    stack.append(item["id"])
                continue
            if not mime.startswith("image/"):
                continue
            yield DriveFile(
                id=item["id"],
                name=item["name"],
                mime_type=mime,
                modified_time=_parse_dt(item.get("modifiedTime")),
            )


def download_bytes(file_id: str) -> bytes:
    svc = _service()
    request = svc.files().get_media(fileId=file_id, supportsAllDrives=True)
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request, chunksize=1024 * 1024)
    done = False
    while not done:
        try:
            _, done = downloader.next_chunk()
        except HttpError as exc:
            raise DriveError(f"Drive download failed for {file_id}: {exc}") from exc
    return buf.getvalue()


def get_metadata(file_id: str) -> DriveFile:
    svc = _service()
    try:
        item = (
            svc.files()
            .get(
                fileId=file_id,
                fields="id,name,mimeType,modifiedTime",
                supportsAllDrives=True,
            )
            .execute()
        )
    except HttpError as exc:
        raise DriveError(f"Drive metadata failed for {file_id}: {exc}") from exc
    return DriveFile(
        id=item["id"],
        name=item["name"],
        mime_type=item["mimeType"],
        modified_time=_parse_dt(item.get("modifiedTime")),
    )
