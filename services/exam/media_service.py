"""Persistent question media storage backed by MongoDB GridFS."""

import time
from bson import ObjectId
from gridfs import GridFSBucket

from services.shared.redis_client import get_exam_db


class QuestionMediaService:
    MAX_BYTES = 30 * 1024 * 1024
    BUCKET_NAME = "exam_question_media"
    META_COLLECTION = "exam_question_media_metadata"
    CHUNK_BYTES = 1024 * 1024

    @classmethod
    def _bucket(cls):
        db = get_exam_db()
        if db is None:
            raise RuntimeError("MongoDB Atlas is unavailable")
        return db, GridFSBucket(db, bucket_name=cls.BUCKET_NAME)

    @classmethod
    def upload(cls, room_id, question_id, file_storage):
        if file_storage is None or not file_storage.filename:
            raise ValueError("A media file is required")

        content_type = (file_storage.mimetype or "").lower()
        if not (content_type.startswith("image/") or content_type.startswith("video/")):
            raise ValueError("Only image and video files are allowed")

        db, bucket = cls._bucket()
        filename = file_storage.filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1] or "media"
        upload_id = None
        total = 0
        try:
            upload_id = ObjectId()
            stream = bucket.open_upload_stream_with_id(
                upload_id,
                filename,
                metadata={
                    "roomId": str(room_id),
                    "questionId": str(question_id),
                    "contentType": content_type,
                },
            )
            while True:
                chunk = file_storage.stream.read(cls.CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > cls.MAX_BYTES:
                    raise ValueError("Media files must be 30 MB or smaller")
                stream.write(chunk)
            stream.close()

            media_id = str(upload_id)
            db[cls.META_COLLECTION].insert_one({
                "_id": upload_id,
                "roomId": str(room_id),
                "questionId": str(question_id),
                "filename": filename,
                "contentType": content_type,
                "size": total,
                "createdAt": int(time.time()),
                "gridfsId": upload_id,
            })
            return {
                "id": media_id,
                "url": f"/api/exam/room/{room_id}/media/{media_id}",
                "type": "video" if content_type.startswith("video/") else "image",
                "mime": content_type,
                "name": filename,
                "size": total,
            }
        except Exception:
            if upload_id is not None:
                try:
                    bucket.delete(upload_id)
                except Exception:
                    pass
            raise

    @classmethod
    def get(cls, room_id, media_id):
        try:
            object_id = ObjectId(str(media_id))
        except Exception:
            raise KeyError("Media not found")

        db, bucket = cls._bucket()
        meta = db[cls.META_COLLECTION].find_one({"_id": object_id, "roomId": str(room_id)})
        if not meta:
            raise KeyError("Media not found")
        try:
            stream = bucket.open_download_stream(meta.get("gridfsId", object_id))
        except Exception:
            raise KeyError("Media not found")
        return meta, stream

    @classmethod
    def delete_room_media(cls, room_id):
        """Delete every GridFS file and metadata record owned by one exam room."""
        db = get_exam_db()
        if db is None:
            return 0
        bucket = GridFSBucket(db, bucket_name=cls.BUCKET_NAME)
        deleted = 0
        metadata = db[cls.META_COLLECTION]
        for item in metadata.find({"roomId": str(room_id)}, {"_id": 1, "gridfsId": 1}):
            file_id = item.get("gridfsId") or item.get("_id")
            if file_id is not None:
                try:
                    bucket.delete(file_id)
                except Exception:
                    # Metadata may exist even when its GridFS object was
                    # already removed; the metadata still must not survive.
                    pass
            deleted += 1
        metadata.delete_many({"roomId": str(room_id)})
        return deleted
