"""world tree: world_nodes (every conversation in one hierarchy of topics, pga.worldtree)

Revision ID: b3d5f7a9c1e4
Revises: a1c3e5b7d9f2
Create Date: 2026-10-21 05:30:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'b3d5f7a9c1e4'
down_revision: Union[str, Sequence[str], None] = 'a1c3e5b7d9f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'world_nodes',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('parent_id', sa.Uuid(), nullable=True),
        sa.Column('depth', sa.Integer(), nullable=False),
        sa.Column('kind', sa.String(length=12), nullable=False),
        sa.Column('title', sa.Text(), nullable=False),
        sa.Column('summary', sa.Text(), nullable=False),
        sa.Column('ref', sa.String(length=200), nullable=True),
        sa.Column('position', sa.Integer(), nullable=False),
        sa.Column('data', sa.JSON().with_variant(postgresql.JSONB(), "postgresql"), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['parent_id'], ['world_nodes.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', 'ref', name='uq_world_nodes_user_ref'),
    )
    op.create_index('ix_world_nodes_user_id', 'world_nodes', ['user_id'])
    op.create_index('ix_world_nodes_parent_id', 'world_nodes', ['parent_id'])


def downgrade() -> None:
    op.drop_index('ix_world_nodes_parent_id', table_name='world_nodes')
    op.drop_index('ix_world_nodes_user_id', table_name='world_nodes')
    op.drop_table('world_nodes')
