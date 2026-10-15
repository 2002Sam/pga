"""links say what they mean: bridges.kind (relates | references | derived_from | depends_on | contradicts)

Revision ID: a4c6e8f0b2d1
Revises: f7b9d1e3a5c6
Create Date: 2026-10-15 19:10:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'a4c6e8f0b2d1'
down_revision: Union[str, Sequence[str], None] = 'f7b9d1e3a5c6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('bridges', sa.Column('kind', sa.String(length=16), server_default='relates', nullable=False))


def downgrade() -> None:
    op.drop_column('bridges', 'kind')
