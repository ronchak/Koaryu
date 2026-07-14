from fastapi import APIRouter, Depends, Query
from typing import Optional
from supabase import Client
from app.core.deps import (
    get_belt_configuration_admin_studio_id,
    get_current_studio_id,
    get_current_user_id,
    get_promotion_manager_studio_id,
    get_supabase,
)
from app.schemas.belt import (
    BeltLadderCreate, BeltLadderUpdate, BeltLadderSyncRequest, BeltLadderResponse,
    BeltRankCreate, BeltRankUpdate, BeltRankResponse,
    DemoteStudent, PromoteStudent, PromotionResponse,
    EligibilityEntry,
)
from app.services.belt_service import BeltService

router = APIRouter(prefix="/belts", tags=["belts"])


@router.get("/ranks", response_model=list[BeltRankResponse])
async def list_ranks(
    ladder_id: Optional[str] = Query(None),
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await BeltService(supabase).list_ranks(studio_id, ladder_id)


@router.get("/ladders", response_model=list[BeltLadderResponse])
async def list_ladders(
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await BeltService(supabase).list_ladders(studio_id)


@router.post("/ladders", response_model=BeltLadderResponse, status_code=201)
async def create_ladder(
    data: BeltLadderCreate,
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_belt_configuration_admin_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await BeltService(supabase).create_ladder(data, studio_id, user_id)


@router.patch("/ladders/{ladder_id}", response_model=BeltLadderResponse)
async def update_ladder(
    ladder_id: str,
    data: BeltLadderUpdate,
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_belt_configuration_admin_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await BeltService(supabase).update_ladder(ladder_id, data, studio_id, user_id)


@router.post("/ladders/{ladder_id}/sync", response_model=BeltLadderResponse)
async def sync_ladder(
    ladder_id: str,
    data: BeltLadderSyncRequest,
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_belt_configuration_admin_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await BeltService(supabase).sync_ladder(ladder_id, data, studio_id, user_id)


@router.post("/ladders/{ladder_id}/ranks", response_model=BeltRankResponse, status_code=201)
async def create_rank(
    ladder_id: str,
    data: BeltRankCreate,
    studio_id: str = Depends(get_belt_configuration_admin_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await BeltService(supabase).create_rank(ladder_id, data, studio_id)


@router.patch("/ranks/{rank_id}", response_model=BeltRankResponse)
async def update_rank(
    rank_id: str,
    data: BeltRankUpdate,
    studio_id: str = Depends(get_belt_configuration_admin_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await BeltService(supabase).update_rank(rank_id, data, studio_id)


@router.delete("/ranks/{rank_id}", status_code=204)
async def delete_rank(
    rank_id: str,
    studio_id: str = Depends(get_belt_configuration_admin_studio_id),
    supabase: Client = Depends(get_supabase),
):
    await BeltService(supabase).delete_rank(rank_id, studio_id)


@router.get("/eligibility", response_model=list[EligibilityEntry])
async def get_eligibility(
    ladder_id: Optional[str] = Query(None),
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await BeltService(supabase).get_eligibility(studio_id, ladder_id)


@router.get("/promotions", response_model=list[PromotionResponse])
async def list_promotions(
    student_id: Optional[str] = Query(None),
    include_names: bool = Query(True),
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await BeltService(supabase).list_promotions(studio_id, student_id, include_names)


@router.post("/promote", response_model=PromotionResponse, status_code=201)
async def promote_student(
    data: PromoteStudent,
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_promotion_manager_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await BeltService(supabase).promote_student(data, studio_id, user_id)


@router.post("/demote", response_model=PromotionResponse, status_code=201)
async def demote_student(
    data: DemoteStudent,
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_promotion_manager_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await BeltService(supabase).demote_student(data, studio_id, user_id)
