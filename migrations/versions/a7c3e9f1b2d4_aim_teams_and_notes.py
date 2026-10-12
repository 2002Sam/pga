"""aim teams and the team board: corrections, plans, work, reviews, summaries

Revision ID: a7c3e9f1b2d4
Revises: 96d3e1dc9cbd
Create Date: 2026-10-12 15:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'a7c3e9f1b2d4'
down_revision: Union[str, Sequence[str], None] = '96d3e1dc9cbd'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

JSON = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql')


def upgrade() -> None:
    op.add_column('aims', sa.Column('team', JSON, nullable=False, server_default='{}'))
    op.create_table('aim_notes',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('aim_id', sa.Uuid(), nullable=False),
    sa.Column('round_id', sa.Uuid(), nullable=True),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('role', sa.String(length=16), nullable=True),
    sa.Column('agent', sa.String(length=64), nullable=True),
    sa.Column('text', sa.Text(), nullable=False),
    sa.Column('text_en', sa.Text(), nullable=False, server_default=''),
    sa.Column('data', JSON, nullable=False, server_default='{}'),
    sa.Column('status', sa.String(length=16), nullable=False, server_default='done'),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['aim_id'], ['aims.id'], name=op.f('fk_aim_notes_aim_id_aims'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_aim_notes_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_aim_notes'))
    )
    op.create_index('ix_aim_notes_aim_time', 'aim_notes', ['aim_id', 'created_at'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_aim_notes_aim_time', table_name='aim_notes')
    op.drop_table('aim_notes')
    op.drop_column('aims', 'team')
