"""information pyramid: gist / brief / full layers for every aim, body and agent

Revision ID: 5b9e3f1a2c70
Revises: d2784db56926
Create Date: 2026-10-11 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '5b9e3f1a2c70'
down_revision: Union[str, Sequence[str], None] = 'd2784db56926'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('layers',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('ref', sa.String(length=80), nullable=False),
    sa.Column('level', sa.Integer(), nullable=False),
    sa.Column('text_en', sa.Text(), nullable=False),
    sa.Column('text', sa.Text(), nullable=False),
    sa.Column('mode', sa.String(length=16), nullable=False),
    sa.Column('words', sa.Integer(), nullable=False),
    sa.Column('source_hash', sa.String(length=64), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_layers_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_layers')),
    sa.UniqueConstraint('user_id', 'ref', 'level', name='uq_layer_ref_level')
    )
    op.create_index('ix_layers_ref', 'layers', ['ref'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_layers_ref', table_name='layers')
    op.drop_table('layers')
