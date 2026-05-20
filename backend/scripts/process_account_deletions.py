import asyncio
import sys

from app.db.supabase import create_supabase_client
from app.services.account_service import AccountService


async def main() -> int:
    result = await AccountService(create_supabase_client()).process_due_deletions()
    print(result.model_dump_json())
    return 1 if result.failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
