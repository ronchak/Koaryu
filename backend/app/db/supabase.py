from typing import Optional
from supabase import create_client, Client
from app.core.config import get_settings

_client: Optional[Client] = None


def get_supabase_client() -> Client:
    """
    Get the Supabase admin client (service role).
    Uses a singleton pattern to avoid recreating the client.
    """
    global _client
    if _client is None:
        settings = get_settings()
        _client = create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY)
    return _client
