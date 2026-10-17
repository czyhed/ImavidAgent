const shapes = {
  box: <><ellipse cx="110" cy="144" rx="72" ry="9" fill="#000" opacity=".06" /><path d="m42 62 91-12 53 25-92 15Z" fill="#FEFEF9" /><path d="M44 70v64l49 18V85Z" fill="#D9DCD0" /><path d="m93 85 91-13v62l-91 18Z" fill="#ECEFE4" /><path d="m37 60 56 22 96-13v12L93 96 37 74Z" fill="#F9FAF2" /><path d="M93 96v56" stroke="#CCD1C2" /></>,
  mug: <><ellipse cx="105" cy="148" rx="57" ry="8" fill="#000" opacity=".07" /><path d="M142 64h13c36 0 35 58 0 58h-13" fill="none" stroke="#C49A73" strokeWidth="14" /><path d="M57 48h91l-5 82c-3 25-77 25-81 0Z" fill="#E3BF96" /><ellipse cx="103" cy="48" rx="46" ry="13" fill="#F7E6CE" /><ellipse cx="103" cy="49" rx="36" ry="8" fill="#A17A59" /><path d="M73 64v59" stroke="#F1D8B6" strokeWidth="6" strokeLinecap="round" /></>,
  lamp: <><ellipse cx="110" cy="153" rx="57" ry="7" fill="#000" opacity=".07" /><ellipse cx="110" cy="145" rx="45" ry="7" fill="#B5C4B7" /><path d="M110 140V76" stroke="#8F9F92" strokeWidth="7" /><path d="M77 35h66l30 53H47Z" fill="#E9ECDD" /><ellipse cx="110" cy="88" rx="63" ry="9" fill="#D1D9BD" /><ellipse cx="110" cy="87" rx="38" ry="4" fill="#F8E5AB" /></>,
  bag: <><ellipse cx="110" cy="155" rx="66" ry="7" fill="#000" opacity=".06" /><path d="M57 62h106l11 88H46Z" fill="#CFC5AF" /><path d="M78 69V43c0-38 64-38 64 0v26" fill="none" stroke="#B4A78D" strokeWidth="10" /><path d="M57 62h106l-6 88H63Z" fill="#E8DFCB" /><path d="M74 80v54M147 80v54" stroke="#D3C8AF" /></>,
  tray: <><ellipse cx="110" cy="144" rx="78" ry="9" fill="#000" opacity=".06" /><path d="m30 76 92-31 77 50-99 40Z" fill="#D4B17C" /><path d="m40 77 82-25 65 42-86 33Z" fill="#E7C998" /><path d="m30 76 70 59 99-40v13l-99 40-70-59Z" fill="#B78C53" /><path d="m57 84 68-20M71 95l69-22M87 108l68-25" stroke="#D6B17D" strokeWidth="2" /></>,
};

export function ProductArt({ product = {} }) {
  if (/^data:image\/(jpeg|png|webp);base64,/.test(product.image || '')) {
    return <img src={product.image} alt={product.name || '商品主图'} />;
  }
  return <svg viewBox="0 0 220 180" aria-hidden="true">{shapes[product.art] || shapes.box}</svg>;
}

export function ProductPicture({ product, kind = '', large = false }) {
  return (
    <div className={`rv-art ${kind} ${large ? 'rv-edit-canvas' : ''}`}>
      <ProductArt product={product} />
      <span className="rv-art-label">交互示意 · 非生成结果</span>
    </div>
  );
}
