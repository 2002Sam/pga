"""fact graph (after graphiti): kg_episodes, kg_entities, kg_edges — facts with when they held (pga.kg)

Revision ID: c4e6a8b0d2f5
Revises: b3d5f7a9c1e4
Create Date: 2026-10-21 06:10:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'c4e6a8b0d2f5'
down_revision: Union[str, Sequence[str], None] = 'b3d5f7a9c1e4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

J = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        'kg_episodes',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('ref', sa.String(length=200), nullable=False),
        sa.Column('part', sa.Integer(), nullable=False),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('valid_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('data', J, nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_kg_episodes_user_id', 'kg_episodes', ['user_id'])
    op.create_index('ix_kg_episodes_ref', 'kg_episodes', ['ref'])
    op.create_table(
        'kg_entities',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('name', sa.Text(), nullable=False),
        sa.Column('label', sa.String(length=40), nullable=False),
        sa.Column('summary', sa.Text(), nullable=False),
        sa.Column('data', J, nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_kg_entities_user_id', 'kg_entities', ['user_id'])
    op.create_table(
        'kg_edges',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('source_id', sa.Uuid(), nullable=False),
        sa.Column('target_id', sa.Uuid(), nullable=False),
        sa.Column('relation', sa.String(length=80), nullable=False),
        sa.Column('fact', sa.Text(), nullable=False),
        sa.Column('episodes', J, nullable=False),
        sa.Column('refs', J, nullable=False),
        sa.Column('valid_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('invalid_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('expired_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('invalidated_by', sa.Uuid(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['source_id'], ['kg_entities.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['target_id'], ['kg_entities.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_kg_edges_user_id', 'kg_edges', ['user_id'])
    op.create_index('ix_kg_edges_source_id', 'kg_edges', ['source_id'])
    op.create_index('ix_kg_edges_target_id', 'kg_edges', ['target_id'])


def downgrade() -> None:
    op.drop_table('kg_edges')
    op.drop_table('kg_entities')
    op.drop_table('kg_episodes')
