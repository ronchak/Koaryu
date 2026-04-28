from typing import Optional
from supabase import create_client, Client
from app.core.config import get_settings

_client: Optional[Client] = None


def create_supabase_client() -> Client:
    """Create an isolated Supabase admin client."""
    settings = get_settings()
    return create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY)


def get_supabase_client() -> Client:
    """
    Get the Supabase admin client (service role).
    Uses a singleton pattern to avoid recreating the client.
    """
    global _client
    if _client is None:
        _client = create_supabase_client()
    return _client
