"""
Copyright 2024, Zep Software, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

Modified by PGA (2026-10-21), from getzep/graphiti @ 8e320f8:
- graphiti_core/utils/maintenance/temporal_edge_utils.py: the future-tense regexes, normalize_future_temporal_bounds,
  apply_extracted_timestamps (works on any object with fact / valid_at / invalid_at);
- graphiti_core/utils/maintenance/edge_operations.py: resolve_edge_contradictions and _apply_temporal_invalidation
  (renamed apply_temporal_invalidation), on PGA's KgEdge rows instead of graphiti's EntityEdge;
- graphiti_core/utils/datetime_utils.py: ensure_utc / utc_now (inlined).
Plus Chinese markers for future plans, deadlines and endings (将, 计划, 打算, 截止, 之前, 不再, 直到…), which the
original English-only regexes miss.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def ensure_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


_FUTURE_ASSERTION_RE = re.compile(
    r"\b("
    r'will|shall|is going to|are going to|going to|'
    r'plans? to|planned to|planning to|'
    r'intends? to|intended to|'
    r'expects? to|expected to|'
    r'promises? to|promised to|'
    r'scheduled to|is scheduled to|are scheduled to|'
    r'set to|aims? to|aimed to|committed to'
    r")\b|[a-z]+'ll\b"
    r'|将要|将会|准备|计划|打算|预计|打算要|会在|要在|承诺',
    re.IGNORECASE,
)

_DEADLINE_RE = re.compile(
    r'\b(by|before|no later than|deadline|due by|due on)\b|截止|之前|以前|前完成|期限',
    re.IGNORECASE,
)

_ONGOING_STATE_END_RE = re.compile(
    r'\b(until|through|thru|expires?|expired|ends?|ended|ending|'
    r'stops?|stopped|ceases?|ceased|no longer)\b|直到|到期|结束|停止|不再',
    re.IGNORECASE,
)


def normalize_future_temporal_bounds(
    fact: str,
    reference_time: datetime | None,
    valid_at: datetime | None,
    invalid_at: datetime | None,
) -> tuple[datetime | None, datetime | None]:
    """Normalize temporal bounds for future-tense assertions.

    For planned/promised/scheduled future facts, ``valid_at`` is the statement's
    reference time, not the future occurrence or deadline date. The future date
    remains part of the fact text or typed attributes. ``invalid_at`` is only for
    facts that stop being true; a soft deadline like "will complete by Friday"
    is not an invalidation time.
    """
    reference_time_utc = ensure_utc(reference_time)
    valid_at_utc = ensure_utc(valid_at)
    invalid_at_utc = ensure_utc(invalid_at)

    if reference_time_utc is None or not _FUTURE_ASSERTION_RE.search(fact):
        return valid_at_utc, invalid_at_utc

    if valid_at_utc is None or valid_at_utc > reference_time_utc:
        valid_at_utc = reference_time_utc

    if (
        invalid_at_utc is not None
        and invalid_at_utc > reference_time_utc
        and _DEADLINE_RE.search(fact)
        and not _ONGOING_STATE_END_RE.search(fact)
    ):
        invalid_at_utc = None

    return valid_at_utc, invalid_at_utc


def apply_extracted_timestamps(
    edge: Any,
    valid_at: str | None,
    invalid_at: str | None,
    reference_time: datetime | None,
) -> None:
    """Parse ISO timestamp strings onto an edge and normalize future bounds."""
    if valid_at:
        try:
            edge.valid_at = ensure_utc(datetime.fromisoformat(valid_at.replace('Z', '+00:00')))
        except ValueError:
            logger.debug('Error parsing valid_at: %s', valid_at)
    if invalid_at:
        try:
            edge.invalid_at = ensure_utc(datetime.fromisoformat(invalid_at.replace('Z', '+00:00')))
        except ValueError:
            logger.debug('Error parsing invalid_at: %s', invalid_at)
    edge.valid_at, edge.invalid_at = normalize_future_temporal_bounds(
        edge.fact,
        reference_time,
        edge.valid_at,
        edge.invalid_at,
    )


def apply_temporal_invalidation(
    resolved_edge: Any,
    invalidation_candidates: list[Any],
) -> list[Any]:
    """Expire the resolved edge and any candidate it contradicts.

    Every check here compares dates, so the caller must have dated the edge first.
    Returns the candidate edges this edge invalidated.
    """
    now = utc_now()

    # The edge arrived with an end date, so it is already historical.
    if resolved_edge.invalid_at and not resolved_edge.expired_at:
        resolved_edge.expired_at = now

    # A candidate that starts later supersedes this edge, so expire this one instead.
    if resolved_edge.expired_at is None:
        invalidation_candidates.sort(key=lambda c: (c.valid_at is None, ensure_utc(c.valid_at) or now))
        for candidate in invalidation_candidates:
            candidate_valid_at_utc = ensure_utc(candidate.valid_at)
            resolved_edge_valid_at_utc = ensure_utc(resolved_edge.valid_at)
            if (
                candidate_valid_at_utc is not None
                and resolved_edge_valid_at_utc is not None
                and candidate_valid_at_utc > resolved_edge_valid_at_utc
            ):
                resolved_edge.invalid_at = candidate.valid_at
                resolved_edge.expired_at = now
                break

    return resolve_edge_contradictions(resolved_edge, invalidation_candidates)


def resolve_edge_contradictions(resolved_edge: Any, invalidation_candidates: list[Any]) -> list[Any]:
    if len(invalidation_candidates) == 0:
        return []

    # Determine which contradictory edges need to be expired
    invalidated_edges: list[Any] = []
    for edge in invalidation_candidates:
        # (Edge invalid before new edge becomes valid) or (new edge invalid before edge becomes valid)
        edge_invalid_at_utc = ensure_utc(edge.invalid_at)
        resolved_edge_valid_at_utc = ensure_utc(resolved_edge.valid_at)
        edge_valid_at_utc = ensure_utc(edge.valid_at)
        resolved_edge_invalid_at_utc = ensure_utc(resolved_edge.invalid_at)

        if (
            edge_invalid_at_utc is not None
            and resolved_edge_valid_at_utc is not None
            and edge_invalid_at_utc <= resolved_edge_valid_at_utc
        ) or (
            edge_valid_at_utc is not None
            and resolved_edge_invalid_at_utc is not None
            and resolved_edge_invalid_at_utc <= edge_valid_at_utc
        ):
            continue
        # New edge invalidates edge
        elif (
            edge_valid_at_utc is not None
            and resolved_edge_valid_at_utc is not None
            and edge_valid_at_utc < resolved_edge_valid_at_utc
        ):
            edge.invalid_at = resolved_edge.valid_at
            edge.expired_at = edge.expired_at if edge.expired_at is not None else utc_now()
            invalidated_edges.append(edge)

    return invalidated_edges
