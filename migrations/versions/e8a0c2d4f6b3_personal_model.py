"""personal model: bodies.data (the five dimensions about you, and other structure a dataset keeps)

Revision ID: e8a0c2d4f6b3
Revises: d7f9b1c3e5a2
Create Date: 2026-10-17 02:20:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'e8a0c2d4f6b3'
down_revision: Union[str, Sequence[str], None] = 'd7f9b1c3e5a2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('bodies', sa.Column('data', sa.JSON().with_variant(postgresql.JSONB(), "postgresql"), nullable=True))


def downgrade() -> None:
    op.drop_column('bodies', 'data')
