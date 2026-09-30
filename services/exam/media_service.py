"""Persistent question media storage backed by MongoDB GridFS.

Media is uploaded in small chunks because the serverless host rejects request
bodies above ~4.5 MB. Chunks are buffered server-side and assembled into a
single GridFS object once the client reports the upload is complete.
"""

import time
from bson import Binary, ObjectId
from gridfs import GridFSBucket

from services.shared.redis_client import get_exam_db


class QuestionMediaService:
    MAX_BYTES = 30 * 1024 * 1024
    BUCKET_NAME = "exam_question_media"
    META_COLLECTION = "exam_question_media_metadata"
    UPLOAD_COLLECTION = "exam_question_media_uploads"
    CHUNK_BYTES = 1024 * 1024
    # Chunk size used by the browser. Kept well under the host's request-body
    # ceiling so multipart overhead can never push a request over the limit.
    UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024
    UPLOAD_TTL_SECONDS = 60 * 60

    @classmethod
    def _bucket(cls):
        db = get_exam_db()
        if db is None:
            raise RuntimeError("MongoDB Atlas is unavailable")
        return db, GridFSBucket(db, bucket_name=cls.BUCKET_NAME)

    @staticmethod
    def _safe_filename(name):
        return (name or "").rsplit("/", 1)[-1].rsplit("\\", 1)[-1] or "media"

    @classmethod
    def _write_media(cls, db, bucket, room_id, question_id, filename, content_type, parts):
        """Stream ``parts`` (an iterable of bytes) into one GridFS object."""
        upload_id = ObjectId()
        total = 0
        try:
            stream = bucket.open_upload_stream_with_id(
                upload_id,
                filename,
                metadata={
                    "roomId": str(room_id),
                    "questionId": str(question_id),
                    "contentType": content_type,
                },
            )
            for part in parts:
                if not part:
                    continue
                total += len(part)
                if total > cls.MAX_BYTES:
                    raise ValueError("Media files must be 30 MB or smaller")
                stream.write(part)
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
            try:
                bucket.delete(upload_id)
            except Exception:
                pass
            raise

    @classmethod
    def upload(cls, room_id, question_id, file_storage):
        """Single-request upload. Kept for small files and backwards compatibility."""
        if file_storage is None or not file_storage.filename:
            raise ValueError("A media file is required")

        content_type = (file_storage.mimetype or "").lower()
        if not (content_type.startswith("image/") or content_type.startswith("video/")):
            raise ValueError("Only image and video files are allowed")

        db, bucket = cls._bucket()

        def parts():
            while True:
                piece = file_storage.stream.read(cls.CHUNK_BYTES)
                if not piece:
                    break
                yield piece

        return cls._write_media(
            db,
            bucket,
            room_id,
            question_id,
            cls._safe_filename(file_storage.filename),
            content_type,
            parts(),
        )

    # ── Chunked upload (bypasses the host's request-body limit) ───────────

    @classmethod
    def store_chunk(cls, room_id, question_id, upload_id, seq, file_storage):
        """Buffer one slice of an in-progress upload."""
        if file_storage is None:
            raise ValueError("A chunk payload is required")
        if not upload_id:
            raise ValueError("An uploadId is required")

        try:
            seq = int(seq)
        except (TypeError, ValueError):
            raise ValueError("A numeric chunk index is required")
        if seq < 0:
            raise ValueError("A numeric chunk index is required")

        blob = file_storage.read()
        if blob is None:
            blob = b""
        if len(blob) > cls.UPLOAD_CHUNK_BYTES:
            raise ValueError("Chunk exceeds the maximum chunk size")

        db = get_exam_db()
        if db is None:
            raise RuntimeError("MongoDB Atlas is unavailable")

        now = int(time.time())
        db[cls.UPLOAD_COLLECTION].update_one(
            {"uploadId": str(upload_id), "seq": seq},
            {
                "$set": {
                    "roomId": str(room_id),
                    "questionId": str(question_id),
                    "size": len(blob),
                    "data": Binary(blob),
                    "updatedAt": now,
                },
                "$setOnInsert": {"createdAt": now},
            },
            upsert=True,
        )
        return {"uploadId": str(upload_id), "seq": seq, "size": len(blob)}

    @classmethod
    def finalize_upload(cls, room_id, question_id, upload_id, filename, content_type, total_chunks):
        """Assemble a finished chunked upload into one GridFS object."""
        if not upload_id:
            raise ValueError("An uploadId is required")

        content_type = (content_type or "").lower()
        if not (content_type.startswith("image/") or content_type.startswith("video/")):
            raise ValueError("Only image and video files are allowed")

        try:
            total_chunks = int(total_chunks)
        except (TypeError, ValueError):
            raise ValueError("totalChunks is required")
        if total_chunks < 1:
            raise ValueError("totalChunks is required")

        db, bucket = cls._bucket()
        chunks = db[cls.UPLOAD_COLLECTION]
        pending = list(
            chunks.find(
                {"uploadId": str(upload_id), "roomId": str(room_id)},
                {"seq": 1, "data": 1},
            ).sort("seq", 1)
        )
        if len(pending) != total_chunks:
            raise ValueError(
                f"Upload incomplete: received {len(pending)} of {total_chunks} chunks"
            )

        def parts():
            for doc in pending:
                yield bytes(doc.get("data") or b"")

        media = cls._write_media(
            db,
            bucket,
            room_id,
            question_id,
            cls._safe_filename(filename),
            content_type,
            parts(),
        )

        # Only clear the buffer once the media is safely assembled. If the
        # write above fails the chunks survive, so the client can retry the
        # finalize call without re-uploading everything.
        chunks.delete_many({"uploadId": str(upload_id), "roomId": str(room_id)})
        return media

    @classmethod
    def abort_upload(cls, room_id, upload_id):
        """Drop buffered chunks for an abandoned upload."""
        db = get_exam_db()
        if db is None:
            return 0
        result = db[cls.UPLOAD_COLLECTION].delete_many(
            {"uploadId": str(upload_id), "roomId": str(room_id)}
        )
        return getattr(result, "deleted_count", 0)

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
        # Buffered chunks for uploads that never completed belong to the room
        # too, and must not outlive it.
        db[cls.UPLOAD_COLLECTION].delete_many({"roomId": str(room_id)})
        return deleted

    @classmethod
    def delete(cls, room_id: str, media_id: str) -> dict:
        """Delete a single media file and its metadata."""
        db = get_exam_db()
        if db is None:
            raise KeyError("Database not available")
        
        metadata_coll = db[cls.META_COLLECTION]
        # Find the metadata record - must belong to this room
        query = {"roomId": str(room_id)}
        if ObjectId.is_valid(media_id):
            query["_id"] = ObjectId(media_id)
        else:
            query["mediaId"] = media_id
        
        meta = metadata_coll.find_one(query)
        if not meta:
            raise KeyError("Media not found")
        
        file_id = meta.get("gridfsId") or meta.get("_id")
        bucket = GridFSBucket(db, bucket_name=cls.BUCKET_NAME)
        
        if file_id is not None:
            try:
                bucket.delete(file_id)
            except Exception:
                pass
        
        metadata_coll.delete_one({"_id": meta["_id"]})
        
        return {
            "id": str(meta.get("_id")),
            "filename": meta.get("filename", ""),
            "contentType": meta.get("contentType", ""),
            "size": meta.get("size", 0),
        }
