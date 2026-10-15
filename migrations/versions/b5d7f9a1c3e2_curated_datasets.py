"""curated datasets PGA keeps itself: bodies.system (user | world | aim) and bodies.compiled_at

Revision ID: b5d7f9a1c3e2
Revises: a4c6e8f0b2d1
Create Date: 2026-10-16 00:50:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'b5d7f9a1c3e2'
down_revision: Union[str, Sequence[str], None] = 'a4c6e8f0b2d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('bodies', sa.Column('system', sa.String(length=16), nullable=True))
    op.add_column('bodies', sa.Column('compiled_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('bodies', 'compiled_at')
    op.drop_column('bodies', 'system')
