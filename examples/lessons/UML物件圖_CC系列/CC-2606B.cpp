// UML 物件圖教案 CC-2606B：兩個分數的加減乘除（Frac 建構時約分）
// （改寫自 CF 題目 CC-2606B：運算子多載、friend、繼承與 static 改成一般成員函式，才能在瀏覽器引擎逐步執行）
#include<iostream>
using namespace std;
int gcd(int a,int b){
   if(a<0)a=-a;
   if(b<0)b=-b;
   return b==0?a:gcd(b,a%b);
}
class Frac{public:
  int m_x,m_y;
  Frac(int n=0,int d=1):m_x(n),m_y(d){
    int g=gcd(m_x,m_y);
    if(g!=0){ m_x/=g; m_y/=g; }
  }
  Frac add(const Frac& b)const{
    return Frac(m_x*b.m_y+m_y*b.m_x, m_y*b.m_y);
  }
  Frac sub(const Frac& b)const{
    return Frac(m_x*b.m_y-m_y*b.m_x, m_y*b.m_y);
  }
  Frac mul(const Frac& b)const{return Frac(m_x*b.m_x, m_y*b.m_y);}
  Frac div(const Frac& b)const{return Frac(m_x*b.m_y, m_y*b.m_x);}
  void read(){
    int p,q;char c;
    cin>>p>>c>>q;
    m_x=p;m_y=q;
  }
  void print()const{cout<<m_x<<"/"<<m_y;}
};

int main(){
  Frac a,b;
  a.read();b.read();
  a.add(b).print();cout<<endl;  //@ @guide uml:a
  a.sub(b).print();cout<<endl;
  a.mul(b).print();cout<<endl;
  a.div(b).print();cout<<endl;
  return 0;
}
