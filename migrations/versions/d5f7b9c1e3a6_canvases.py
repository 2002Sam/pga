"""无限画布: canvases — a blueprint-like board per world-tree topic (pga.canvas)

Revision ID: d5f7b9c1e3a6
Revises: c4e6a8b0d2f5
Create Date: 2026-10-22 04:30:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'd5f7b9c1e3a6'
down_revision: Union[str, Sequence[str], None] = 'c4e6a8b0d2f5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

J = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        'canvases',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('world', sa.String(length=64), nullable=False),
        sa.Column('title', sa.Text(), nullable=False),
        sa.Column('rev', sa.Integer(), nullable=False),
        sa.Column('data', J, nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', 'world', name='uq_canvases_user_world'),
    )
    op.create_index('ix_canvases_user_id', 'canvases', ['user_id'])


def downgrade() -> None:
    op.drop_index('ix_canvases_user_id', table_name='canvases')
    op.drop_table('canvases')
