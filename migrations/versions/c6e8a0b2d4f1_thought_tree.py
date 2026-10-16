"""thought tree: thought_nodes (a motivation's self-dialogue cut into nodes, with branches and buds)

Revision ID: c6e8a0b2d4f1
Revises: b5d7f9a1c3e2
Create Date: 2026-10-16 22:40:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'c6e8a0b2d4f1'
down_revision: Union[str, Sequence[str], None] = 'b5d7f9a1c3e2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

J = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        'thought_nodes',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('aim_id', sa.Uuid(), sa.ForeignKey('aims.id', ondelete='CASCADE'), nullable=False),
        sa.Column('parent_id', sa.Uuid(), sa.ForeignKey('thought_nodes.id', ondelete='CASCADE'), nullable=True),
        sa.Column('kind', sa.String(length=16), nullable=False, server_default='segment'),
        sa.Column('seq', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('title', sa.Text(), nullable=False, server_default=''),
        sa.Column('summary', sa.Text(), nullable=False, server_default=''),
        sa.Column('shift', sa.Text(), nullable=False, server_default=''),
        sa.Column('key_thoughts', J, nullable=False),
        sa.Column('note_ids', J, nullable=False),
        sa.Column('first_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('git', J, nullable=False),
        sa.Column('data', J, nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_thought_nodes_aim_seq', 'thought_nodes', ['aim_id', 'seq'])


def downgrade() -> None:
    op.drop_index('ix_thought_nodes_aim_seq', table_name='thought_nodes')
    op.drop_table('thought_nodes')
