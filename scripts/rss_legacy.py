"""Read-only optional access to historical Hello Week previews."""
import contextlib
from pathlib import Path
import sqlite3


def read_legacy(config, operation, payload=None):
    value = config.get("rss_legacy_portal_db")
    path = Path(value) if isinstance(value, str) and value else None
    if path is None or not path.is_absolute() or not path.is_file():
        return {"available": False, "weeks": []} if operation == "legacy_weeks" else {}
    with contextlib.closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as connection:
        connection.row_factory = sqlite3.Row
        if operation == "legacy_weeks":
            rows = connection.execute("SELECT w.week_start,w.updated_at,LENGTH(w.rich_html) rich_html_length,COUNT(a.id) article_count FROM hello_weeks w LEFT JOIN articles a ON a.week_start=w.week_start GROUP BY w.week_start ORDER BY w.week_start DESC")
            return {"available": True, "weeks": [dict(row) for row in rows]}
        row = connection.execute("SELECT * FROM hello_weeks WHERE week_start=?", ((payload or {}).get("week_start"),)).fetchone()
        return {"week": dict(row)} if row else {}
